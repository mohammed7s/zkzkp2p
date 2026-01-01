/**
 * Minimal Solver for zkzkp2p
 *
 * This is a minimal solver that serves the zkzkp2p website. It:
 * 1. Listens for lock events on both chains (Aztec & Base Sepolia)
 * 2. Counter-locks on the opposite chain when it detects a user lock
 * 3. Watches for redeem events to extract secrets
 * 4. Completes swaps by redeeming on the original chain
 *
 * Flow: Aztec → Base (user sends from Aztec to receive on Base)
 *   - User calls lock_src on Aztec (SrcLocked event)
 *   - Solver locks on Base (TokenLocked event)
 *   - User redeems on Base (TokenRedeemed event, reveals secret)
 *   - Solver redeems on Aztec using revealed secret
 *
 * Flow: Base → Aztec (user sends from Base to receive on Aztec)
 *   - User calls lock on Base (TokenLocked event)
 *   - Solver calls lock_dst on Aztec (DstLocked event)
 *   - User redeems on Aztec (TokenRedeemed event, reveals secret)
 *   - Solver redeems on Base using revealed secret
 *
 * Run: npx tsx solver.ts
 */

// Suppress noisy Aztec/pino logs - MUST be before imports
process.env.LOG_LEVEL = 'fatal';
process.env.DEBUG = '';
process.env.AZTEC_LOG_LEVEL = 'fatal';
process.env.PXE_LOG_LEVEL = 'fatal';
process.env.PINO_LOG_LEVEL = 'fatal';

import dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import * as http from 'http';
import { Fr, GrumpkinScalar } from '@aztec/foundation/fields';
import { TestWallet } from '@aztec/test-wallet/server';
import { AztecNode, createAztecNodeClient } from '@aztec/aztec.js/node';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { ContractFunctionInteractionCallIntent } from '@aztec/aztec.js/authorization';
import { TrainContract } from './Train.ts';

// ESM __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
const envPath = path.join(__dirname, '.env.solver');
const result = dotenv.config({ path: envPath });
if (result.parsed) {
  for (const [key, value] of Object.entries(result.parsed)) {
    process.env[key] = value;
  }
}

// ==================== CONFIGURATION ====================

const AZTEC_NODE_URL = process.env.AZTEC_NODE_URL || 'https://devnet.aztec-labs.com';
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';

// Solver keys
const AZTEC_SOLVER_SECRET_KEY = process.env.AZTEC_SOLVER_SECRET_KEY || '';
const AZTEC_SOLVER_SALT = process.env.AZTEC_SOLVER_SALT || '';
const AZTEC_SOLVER_SIGNING_KEY = process.env.AZTEC_SOLVER_SIGNING_KEY || '';
const EVM_SOLVER_PRIVATE_KEY = process.env.EVM_SOLVER_PRIVATE_KEY || '';

// Contract addresses
const AZTEC_TRAIN_ADDRESS = process.env.AZTEC_TRAIN_ADDRESS || '';
const AZTEC_TOKEN_ADDRESS = process.env.AZTEC_TOKEN_ADDRESS || '';
const BASE_TRAIN_ADDRESS = process.env.BASE_TRAIN_ADDRESS || '';
const BASE_TOKEN_ADDRESS = process.env.BASE_TOKEN_ADDRESS || '';

// Timing
const POLL_INTERVAL = 10000; // 10 seconds
const TX_TIMEOUT = 600000; // 10 minutes
const TIMELOCK_BUFFER = 3600; // 1 hour buffer for solver timelock (shorter than user's)
const HTTP_PORT = parseInt(process.env.SOLVER_HTTP_PORT || '3001');

// Token decimals
const TOKEN_DECIMALS = 6n;

// ==================== ABIs ====================

const TRAIN_ERC20_ABI = [
  'event TokenLocked(bytes32 indexed Id, bytes32 hashlock, string dstChain, string dstAddress, string dstAsset, address indexed sender, address indexed srcReceiver, string srcAsset, uint256 amount, uint256 reward, uint48 rewardTimelock, uint48 timelock, address tokenContract)',
  'event TokenRedeemed(bytes32 indexed Id, address redeemAddress, uint256 secret, bytes32 hashlock)',
  'function lock((bytes32 Id, bytes32 hashlock, uint256 reward, uint48 rewardTimelock, uint48 timelock, address srcReceiver, string srcAsset, string dstChain, string dstAddress, string dstAsset, uint256 amount, address tokenContract) params) returns (bytes32)',
  'function redeem(bytes32 Id, uint256 secret) returns (bool)',
  'function getHTLCDetails(bytes32 Id) view returns (tuple(uint256 amount, bytes32 hashlock, uint256 secret, address tokenContract, uint48 timelock, uint8 claimed, address sender, address srcReceiver))',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

// ==================== STATE ====================

interface PendingSwap {
  swapId: string;
  direction: 'aztec_to_base' | 'base_to_aztec';
  amount: bigint;
  hashlockHigh: bigint;
  hashlockLow: bigint;
  hashlock: string; // bytes32 for EVM
  userAztecAddress?: string;
  userEvmAddress?: string;
  solverLocked: boolean;
  userRedeemed: boolean;
  solverRedeemed: boolean;
  createdAt: number;
}

const pendingSwaps = new Map<string, PendingSwap>();
let aztecLastProcessedBlock = 0;
let pollCount = 0;
const POLL_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Concurrency control - only process one Aztec/Base lock at a time
let isProcessingAztecLock = false;
let isProcessingBaseLock = false;
const pendingAztecLocks: PendingSwap[] = [];
const pendingBaseLocks: PendingSwap[] = [];

// ==================== HELPERS ====================

function hashlockToBytes32(high: bigint, low: bigint): string {
  return '0x' + high.toString(16).padStart(32, '0') + low.toString(16).padStart(32, '0');
}

function bytes32ToHashlockParts(hashlock: string): [bigint, bigint] {
  const hex = hashlock.slice(2); // Remove 0x
  const high = BigInt('0x' + hex.slice(0, 32));
  const low = BigInt('0x' + hex.slice(32, 64));
  return [high, low];
}

function secretToUint256(high: bigint, low: bigint): bigint {
  return (high << 128n) | low;
}

function uint256ToSecretParts(secret: bigint): [bigint, bigint] {
  const high = secret >> 128n;
  const low = secret & ((1n << 128n) - 1n);
  return [high, low];
}

function swapIdToBytes32(swapId: string): string {
  // If it's already a proper hex, use it
  if (swapId.startsWith('0x') && swapId.length === 66) {
    return swapId;
  }
  // Otherwise pad it
  return '0x' + swapId.replace('0x', '').padStart(64, '0');
}

function log(msg: string, ...args: any[]) {
  // Clear the status line before logging
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
  console.log(`[${new Date().toISOString()}] ${msg}`, ...args);
}

function updateStatusLine() {
  if (!process.stdout.isTTY) return;

  const frame = POLL_FRAMES[pollCount % POLL_FRAMES.length];

  // Count swaps by state
  let waitingLock = 0, waitingRedeem = 0, complete = 0;
  for (const swap of pendingSwaps.values()) {
    if (!swap.solverLocked) waitingLock++;
    else if (!swap.userRedeemed) waitingRedeem++;
    else complete++;
  }

  const swapInfo = pendingSwaps.size > 0
    ? ` | swaps: ${waitingLock} locking, ${waitingRedeem} awaiting redeem`
    : ' | idle';
  const queueInfo = (pendingAztecLocks.length + pendingBaseLocks.length) > 0
    ? ` | ${pendingAztecLocks.length + pendingBaseLocks.length} queued`
    : '';
  const processingInfo = isProcessingAztecLock ? ' [locking AZ]' : isProcessingBaseLock ? ' [locking BASE]' : '';
  const status = `${frame}${swapInfo}${queueInfo}${processingInfo}`;

  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(status);

  pollCount++;
}

// ==================== AZTEC SETUP ====================

let aztecNode: AztecNode;
let solverWallet: TestWallet;
let solverAccount: any;
let solverPayment: SponsoredFeePaymentMethod;
let solverTrain: any;
let solverToken: any;

async function setupAztec() {
  log('Setting up Aztec connection...');

  aztecNode = createAztecNodeClient(AZTEC_NODE_URL);

  // Verify connection
  const nodeInfo = await aztecNode.getNodeInfo();
  // Try different property names for block number (SDK may vary)
  const blockNumber = nodeInfo.l2BlockNumber ?? (nodeInfo as any).blockNumber ?? await aztecNode.getBlockNumber();
  log(`Connected to Aztec. Block: ${blockNumber}`);

  // Create solver wallet
  solverWallet = await TestWallet.create(aztecNode);

  const solverSecretKey = Fr.fromString(AZTEC_SOLVER_SECRET_KEY);
  const solverSalt = Fr.fromString(AZTEC_SOLVER_SALT);
  const solverSigningKey = (GrumpkinScalar as any).fromString(AZTEC_SOLVER_SIGNING_KEY);

  solverAccount = await solverWallet.createSchnorrAccount(
    solverSecretKey,
    solverSalt,
    solverSigningKey,
  );
  log(`Solver Aztec address: ${solverAccount.address.toString()}`);

  // Get sponsored payment method
  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  await solverWallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
  solverPayment = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);

  // Register contracts
  const trainAddress = AztecAddress.fromString(AZTEC_TRAIN_ADDRESS);
  const tokenAddress = AztecAddress.fromString(AZTEC_TOKEN_ADDRESS);

  const trainInstance = await aztecNode.getContract(trainAddress);
  const tokenInstance = await aztecNode.getContract(tokenAddress);

  if (!trainInstance || !tokenInstance) {
    throw new Error('Aztec contracts not found');
  }

  await solverWallet.registerContract(trainInstance, TrainContract.artifact);
  await solverWallet.registerContract(tokenInstance, TokenContract.artifact);
  await solverWallet.registerSender(trainAddress);

  solverTrain = await TrainContract.at(trainAddress, solverWallet);
  solverToken = await TokenContract.at(tokenAddress, solverWallet);

  // Check solver's Aztec token balance at startup
  try {
    const aztecBalance = await solverToken.methods
      .balance_of_public(solverAccount.address)
      .simulate({ from: solverAccount.address });
    log(`Solver Aztec USDC balance: ${aztecBalance}`);
    if (BigInt(aztecBalance) === 0n) {
      log('⚠️  WARNING: Solver has 0 USDC on Aztec! Shield flow will fail.');
      log('   Mint tokens to solver or transfer from another account.');
    }
  } catch (e) {
    log('Could not check Aztec balance:', e);
  }

  // Set initial block to poll from (use the block number we determined earlier)
  const currentBlock = nodeInfo.l2BlockNumber ?? (nodeInfo as any).blockNumber ?? await aztecNode.getBlockNumber();
  aztecLastProcessedBlock = Math.max(0, currentBlock - 10); // Start from 10 blocks ago

  log('Aztec setup complete');
}

// ==================== EVM SETUP ====================

let evmProvider: ethers.JsonRpcProvider;
let evmSolverWallet: ethers.Wallet;
let trainErc20: ethers.Contract;
let baseToken: ethers.Contract;

async function setupEvm() {
  log('Setting up EVM connection...');

  evmProvider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
  evmSolverWallet = new ethers.Wallet(EVM_SOLVER_PRIVATE_KEY, evmProvider);

  trainErc20 = new ethers.Contract(BASE_TRAIN_ADDRESS, TRAIN_ERC20_ABI, evmProvider);
  baseToken = new ethers.Contract(BASE_TOKEN_ADDRESS, ERC20_ABI, evmProvider);

  const balance = await baseToken.balanceOf(evmSolverWallet.address);
  log(`Solver EVM address: ${evmSolverWallet.address}`);
  log(`Solver EVM balance: ${ethers.formatUnits(balance, 6)} USDC`);

  log('EVM setup complete');
}

// ==================== EVENT HANDLERS ====================

/**
 * Handle SrcLocked event from Aztec (user locked on Aztec, wants Base)
 * Solver needs to lock on Base
 */
async function handleAztecSrcLocked(event: any) {
  const swapId = event.swapId.toString();

  // Skip if already tracked (don't log - this happens every poll cycle)
  if (pendingSwaps.has(swapId)) {
    return;
  }

  log(`[Aztec] New SrcLocked detected. Swap ID: ${swapId}`);

  // Parse event data
  const hashlockHigh = BigInt(event.hashlockHigh);
  const hashlockLow = BigInt(event.hashlockLow);
  const amount = BigInt(event.amount);
  const dstAddress = event.dstAddress.trim(); // EVM address where user wants to receive

  log(`[Aztec] User wants to swap ${amount} to ${dstAddress} on Base`);

  // Create pending swap record
  const swap: PendingSwap = {
    swapId,
    direction: 'aztec_to_base',
    amount,
    hashlockHigh,
    hashlockLow,
    hashlock: hashlockToBytes32(hashlockHigh, hashlockLow),
    userEvmAddress: dstAddress,
    solverLocked: false,
    userRedeemed: false,
    solverRedeemed: false,
    createdAt: Date.now(),
  };
  pendingSwaps.set(swapId, swap);

  // Queue lock on Base
  log(`[Aztec] Queueing swap for Base lock (${pendingBaseLocks.length + 1} in queue)`);
  pendingBaseLocks.push(swap);
  processNextBaseLock();
}

/**
 * Handle TokenLocked event from Base (user locked on Base, wants Aztec)
 * Solver needs to lock on Aztec
 */
async function handleEvmTokenLocked(event: ethers.EventLog) {
  const swapId = event.args?.Id as string;

  // Skip if already tracked (don't log - this happens every poll cycle)
  if (pendingSwaps.has(swapId)) {
    return;
  }

  log(`[EVM] New TokenLocked detected. Swap ID: ${swapId}`);

  const hashlock = event.args?.hashlock as string;
  const amount = event.args?.amount as bigint;
  const dstAddress = (event.args?.dstAddress as string).trim(); // Aztec address
  const dstChain = (event.args?.dstChain as string).trim();

  // Only process swaps destined for our Aztec network
  if (!dstChain.includes('AZTEC')) {
    log(`[EVM] Ignoring swap to ${dstChain}`);
    return;
  }

  log(`[EVM] User wants to swap ${amount} to ${dstAddress} on Aztec`);

  const [hashlockHigh, hashlockLow] = bytes32ToHashlockParts(hashlock);

  // Create pending swap record
  const swap: PendingSwap = {
    swapId,
    direction: 'base_to_aztec',
    amount,
    hashlockHigh,
    hashlockLow,
    hashlock,
    userAztecAddress: dstAddress,
    solverLocked: false,
    userRedeemed: false,
    solverRedeemed: false,
    createdAt: Date.now(),
  };
  pendingSwaps.set(swapId, swap);

  // Queue lock on Aztec
  log(`[EVM] Queueing swap for Aztec lock (${pendingAztecLocks.length + 1} in queue)`);
  pendingAztecLocks.push(swap);
  processNextAztecLock();
}

/**
 * Handle TokenRedeemed from Base (user revealed secret on Base)
 * Solver can now redeem on Aztec
 */
async function handleEvmTokenRedeemed(event: ethers.EventLog) {
  const swapId = event.args?.Id as string;
  const secret = event.args?.secret as bigint;

  log(`[EVM] TokenRedeemed detected. Swap ID: ${swapId}`);

  const swap = pendingSwaps.get(swapId);
  if (!swap) {
    log(`[EVM] Unknown swap ${swapId}, ignoring`);
    return;
  }

  if (swap.direction !== 'aztec_to_base') {
    log(`[EVM] Swap ${swapId} is not aztec_to_base, ignoring redeem`);
    return;
  }

  if (swap.solverRedeemed) {
    log(`[EVM] Solver already redeemed swap ${swapId}`);
    return;
  }

  log(`[EVM] Secret revealed: ${secret}`);
  swap.userRedeemed = true;

  // Now redeem on Aztec
  await redeemOnAztec(swap, secret);
}

/**
 * Handle TokenRedeemed from Aztec (user revealed secret on Aztec)
 * Solver can now redeem on Base
 */
async function handleAztecTokenRedeemed(event: any) {
  const swapId = event.swapId.toString();
  const secretHigh = BigInt(event.secretHigh);
  const secretLow = BigInt(event.secretLow);
  const secret = secretToUint256(secretHigh, secretLow);

  log(`[Aztec] TokenRedeemed detected. Swap ID: ${swapId}`);

  const swap = pendingSwaps.get(swapId);
  if (!swap) {
    log(`[Aztec] Unknown swap ${swapId}, ignoring`);
    return;
  }

  if (swap.direction !== 'base_to_aztec') {
    log(`[Aztec] Swap ${swapId} is not base_to_aztec, ignoring redeem`);
    return;
  }

  if (swap.solverRedeemed) {
    log(`[Aztec] Solver already redeemed swap ${swapId}`);
    return;
  }

  log(`[Aztec] Secret revealed: ${secret}`);
  swap.userRedeemed = true;

  // Now redeem on Base
  await redeemOnBase(swap, secret);
}

// ==================== LOCK FUNCTIONS ====================

/**
 * Lock tokens on Base (for aztec_to_base swaps)
 */
async function lockOnBase(swap: PendingSwap) {
  log(`[Solver] Locking on Base for swap ${swap.swapId}...`);

  try {
    // Validate we have user's EVM address
    if (!swap.userEvmAddress) {
      log(`[Solver] Cannot lock on Base - missing userEvmAddress for swap ${swap.swapId}`);
      log(`[Solver] Use /notify-lock endpoint to provide address, or wait for event re-parsing`);
      // Put back in queue to retry later
      pendingBaseLocks.push(swap);
      return;
    }

    // Check balance
    const balance = await baseToken.balanceOf(evmSolverWallet.address);
    if (balance < swap.amount) {
      log(`[Solver] Insufficient balance: ${balance} < ${swap.amount}`);
      return;
    }

    // Approve tokens
    const allowance = await baseToken.allowance(evmSolverWallet.address, BASE_TRAIN_ADDRESS);
    if (allowance < swap.amount) {
      log(`[Solver] Approving tokens...`);
      const approveTx = await baseToken.connect(evmSolverWallet).approve(BASE_TRAIN_ADDRESS, swap.amount);
      await approveTx.wait();
    }

    // Get timelock (shorter than user's timelock)
    const block = await evmProvider.getBlock('latest');
    const timelock = block!.timestamp + TIMELOCK_BUFFER;

    const lockParams = {
      Id: swapIdToBytes32(swap.swapId),
      hashlock: swap.hashlock,
      reward: 0n,
      rewardTimelock: timelock - 100,
      timelock: timelock,
      srcReceiver: swap.userEvmAddress!,
      srcAsset: 'USDC',
      dstChain: 'AZTEC_DEVNET',
      dstAddress: solverAccount.address.toString(),
      dstAsset: 'USDC',
      amount: swap.amount,
      tokenContract: BASE_TOKEN_ADDRESS,
    };

    log(`[Solver] Locking ${swap.amount} USDC on Base...`);
    const lockTx = await trainErc20.connect(evmSolverWallet).lock(lockParams, {
      gasLimit: 300000n,
    });
    const receipt = await lockTx.wait();

    swap.solverLocked = true;
    log(`[Solver] Locked on Base! Tx: ${receipt.hash}`);

  } catch (err) {
    log(`[Solver] Failed to lock on Base:`, err);
  } finally {
    isProcessingBaseLock = false;
    processNextBaseLock();
  }
}

/**
 * Process queued Base locks sequentially
 */
function processNextBaseLock() {
  if (isProcessingBaseLock || pendingBaseLocks.length === 0) return;

  isProcessingBaseLock = true;
  const swap = pendingBaseLocks.shift()!;
  lockOnBase(swap); // Fire and forget - it will call processNext when done
}

/**
 * Lock tokens on Aztec (for base_to_aztec swaps)
 */
async function lockOnAztec(swap: PendingSwap) {
  log(`[Solver] Locking on Aztec for swap ${swap.swapId}...`);

  try {
    // Check balance
    const balance = await solverToken.methods
      .balance_of_public(solverAccount.address)
      .simulate({ from: solverAccount.address });

    // Train contract requires: reward * 10 >= amount (minimum 10% reward)
    // Use ceiling division to get the smallest valid reward
    const reward = (swap.amount + 9n) / 10n;
    const totalAmount = swap.amount + reward;

    log(`[Solver] Aztec public balance: ${balance}, need: ${totalAmount}`);

    if (BigInt(balance) < totalAmount) {
      log(`[Solver] Insufficient Aztec balance: ${balance} < ${totalAmount}`);
      return;
    }

    // Set authwit for token transfer
    const tokenAddress = AztecAddress.fromString(AZTEC_TOKEN_ADDRESS);
    const trainAddress = AztecAddress.fromString(AZTEC_TRAIN_ADDRESS);

    const transferAction = solverToken.methods.transfer_in_public(
      solverAccount.address,
      trainAddress,
      totalAmount,
      0n,
    );

    const intent: ContractFunctionInteractionCallIntent = {
      caller: trainAddress,
      action: transferAction,
    };

    log(`[Solver] Setting authwit...`);
    const authwitInteraction = await solverWallet.setPublicAuthWit(
      solverAccount.address,
      intent,
      true,
    );
    await authwitInteraction
      .send({ from: solverAccount.address, fee: { paymentMethod: solverPayment } })
      .wait({ timeout: TX_TIMEOUT });

    // Get timelock
    const blockHeader = await aztecNode.getBlockHeader();
    const aztecTimestamp = Number(blockHeader?.globalVariables?.timestamp ?? Math.floor(Date.now() / 1000));
    log(`[Solver] Block timestamp: ${aztecTimestamp}`);
    const timelock = aztecTimestamp + TIMELOCK_BUFFER;
    const rewardTimelock = timelock - 300; // 5 minutes before main timelock

    // lock_dst expects: swap_id, htlc_id, hashlock_high, hashlock_low, reward, reward_timelock,
    //                   timelock, src_receiver, token, total_amount, src_asset, dst_chain, dst_asset, dst_address
    // For shield flow (Base → Aztec), use htlc_id=0 so user can check has_htlc(swapId, 0)
    const htlcId = 0n;

    // Pre-check: verify HTLC doesn't already exist (catches duplicate/old events)
    const htlcExists = await solverTrain.methods
      .has_htlc(Fr.fromString(swapIdToBytes32(swap.swapId)), htlcId)
      .simulate({ from: solverAccount.address });

    if (htlcExists) {
      log(`[Solver] HTLC already exists for swap ${swap.swapId} - skipping (likely old event)`);
      swap.solverLocked = true; // Mark as done so we don't retry
      return;
    }

    log(`[Solver] Calling lock_dst...`);
    log(`[Solver]   swapId: ${swapIdToBytes32(swap.swapId)}`);
    log(`[Solver]   htlcId: ${htlcId}`);
    log(`[Solver]   hashlock: ${swap.hashlockHigh}, ${swap.hashlockLow}`);
    log(`[Solver]   amount: ${totalAmount}`);
    log(`[Solver]   userAztecAddress: ${swap.userAztecAddress}`);
    log(`[Solver]   timelock: ${timelock}`);

    const lockTx = await solverTrain.methods
      .lock_dst(
        Fr.fromString(swapIdToBytes32(swap.swapId)),
        htlcId,
        swap.hashlockHigh,
        swap.hashlockLow,
        reward,
        rewardTimelock,
        timelock,
        AztecAddress.fromString(swap.userAztecAddress!),
        tokenAddress,
        totalAmount,
        'USDC'.padStart(30, ' '),
        'BASE_SEPOLIA'.padStart(30, ' '),
        'USDC'.padStart(30, ' '),
        evmSolverWallet.address.padStart(90, ' '),
      )
      .send({ from: solverAccount.address, fee: { paymentMethod: solverPayment } })
      .wait({ timeout: TX_TIMEOUT });

    swap.solverLocked = true;
    log(`[Solver] Locked on Aztec! Tx: ${lockTx.txHash.toString()}`);

  } catch (err) {
    log(`[Solver] Failed to lock on Aztec:`, err);
  } finally {
    isProcessingAztecLock = false;
    processNextAztecLock();
  }
}

/**
 * Process queued Aztec locks sequentially
 */
function processNextAztecLock() {
  if (isProcessingAztecLock || pendingAztecLocks.length === 0) return;

  isProcessingAztecLock = true;
  const swap = pendingAztecLocks.shift()!;
  lockOnAztec(swap); // Fire and forget - it will call processNext when done
}

// ==================== REDEEM FUNCTIONS ====================

/**
 * Redeem on Aztec (after user revealed secret on Base)
 */
async function redeemOnAztec(swap: PendingSwap, secret: bigint) {
  log(`[Solver] Redeeming on Aztec for swap ${swap.swapId}...`);

  try {
    const [secretHigh, secretLow] = uint256ToSecretParts(secret);

    const redeemTx = await solverTrain.methods
      .redeem(
        Fr.fromString(swapIdToBytes32(swap.swapId)),
        0n, // htlc_id=0 for user locks
        secretHigh,
        secretLow,
      )
      .send({ from: solverAccount.address, fee: { paymentMethod: solverPayment } })
      .wait({ timeout: TX_TIMEOUT });

    swap.solverRedeemed = true;
    log(`[Solver] Redeemed on Aztec! Tx: ${redeemTx.txHash.toString()}`);

    // Cleanup
    pendingSwaps.delete(swap.swapId);
    log(`[Solver] Swap ${swap.swapId} completed!`);

  } catch (err) {
    log(`[Solver] Failed to redeem on Aztec:`, err);
  }
}

/**
 * Redeem on Base (after user revealed secret on Aztec)
 */
async function redeemOnBase(swap: PendingSwap, secret: bigint) {
  log(`[Solver] Redeeming on Base for swap ${swap.swapId}...`);

  try {
    const redeemTx = await trainErc20.connect(evmSolverWallet).redeem(
      swapIdToBytes32(swap.swapId),
      secret,
      { gasLimit: 150000n },
    );
    const receipt = await redeemTx.wait();

    swap.solverRedeemed = true;
    log(`[Solver] Redeemed on Base! Tx: ${receipt.hash}`);

    // Cleanup
    pendingSwaps.delete(swap.swapId);
    log(`[Solver] Swap ${swap.swapId} completed!`);

  } catch (err) {
    log(`[Solver] Failed to redeem on Base:`, err);
  }
}

// ==================== EVENT POLLING ====================

/**
 * Poll for EVM events using event filters
 */
async function pollEvmEvents() {
  try {
    // Get current block
    const currentBlock = await evmProvider.getBlockNumber();
    const fromBlock = Math.max(currentBlock - 100, 0); // Last 100 blocks

    // Query TokenLocked events
    const lockedFilter = trainErc20.filters.TokenLocked();
    const lockedEvents = await trainErc20.queryFilter(lockedFilter, fromBlock, currentBlock);

    for (const event of lockedEvents) {
      if (event instanceof ethers.EventLog) {
        await handleEvmTokenLocked(event);
      }
    }

    // Query TokenRedeemed events
    const redeemedFilter = trainErc20.filters.TokenRedeemed();
    const redeemedEvents = await trainErc20.queryFilter(redeemedFilter, fromBlock, currentBlock);

    for (const event of redeemedEvents) {
      if (event instanceof ethers.EventLog) {
        await handleEvmTokenRedeemed(event);
      }
    }

  } catch (err) {
    log('[EVM] Error polling events:', err);
  }
}

// Event signatures from Train contract
const EVENT_SIG_SRC_LOCKED = 0x1A2B3C4Dn;
const EVENT_SIG_DST_LOCKED = 0x2B3C4D5En;
const EVENT_SIG_REDEEMED = 0x4F8B9A3En;
const EVENT_SIG_REFUNDED = 0x2D17C6B8n;

/**
 * Poll for Aztec events using getPublicLogs
 * Detects SrcLocked (deposit flow) and TokenRedeemed (shield flow) events
 */
async function pollAztecEvents() {
  try {
    // Get current block number (try multiple property names for SDK compatibility)
    const nodeInfo = await aztecNode.getNodeInfo();
    const currentBlock = nodeInfo.l2BlockNumber ?? (nodeInfo as any).blockNumber ?? await aztecNode.getBlockNumber();

    if (!currentBlock || currentBlock <= aztecLastProcessedBlock) {
      return;
    }

    // Query public logs from the Train contract
    const logs = await aztecNode.getPublicLogs({
      fromBlock: aztecLastProcessedBlock + 1,
      toBlock: currentBlock + 1,
      contractAddress: AztecAddress.fromString(AZTEC_TRAIN_ADDRESS),
    });

    // Process each log entry
    for (const logEntry of logs.logs) {
      try {
        // Parse the log data as Fields
        const fields = logEntry.log.data;
        if (fields.length < 2) continue;

        const eventSig = fields[0].toBigInt();

        // Handle SrcLocked event (deposit flow - user locked on Aztec)
        if (eventSig === EVENT_SIG_SRC_LOCKED && fields.length >= 13) {
          const swapId = fields[1].toString();

          // Skip if already tracked
          if (pendingSwaps.has(swapId)) continue;

          const hashlockHigh = fields[2].toBigInt();
          const hashlockLow = fields[3].toBigInt();
          const amount = fields[6].toBigInt();

          // Extract dst_address from event fields (stored in fields 11, 12 as bytes)
          // The address is space-padded to 90 chars, split across 3 x 30-byte fields
          // Field 11 = bytes 30-59, Field 12 = bytes 60-89
          // EVM address is 42 chars (0x + 40 hex), so it spans both fields
          let dstAddress = '';
          try {
            // Convert Field to bytes and then to ASCII string
            const field11Bytes = Buffer.from(fields[11].toBigInt().toString(16).padStart(60, '0'), 'hex');
            const field12Bytes = Buffer.from(fields[12].toBigInt().toString(16).padStart(60, '0'), 'hex');

            // Combine and convert to string
            const combined = Buffer.concat([field11Bytes, field12Bytes]).toString('utf8');

            // Look for EVM address pattern (0x followed by 40 hex chars)
            const addressMatch = combined.match(/0x[0-9a-fA-F]{40}/i);
            if (addressMatch) {
              dstAddress = addressMatch[0];
            }
          } catch (addrErr) {
            log(`[Aztec] Could not parse dst_address from event, using notify-lock fallback`);
          }

          log(`[Aztec] New SrcLocked detected. Swap ID: ${swapId}`);
          log(`[Aztec] User wants to swap ${amount} to ${dstAddress || '(address pending)'} on Base`);

          const swap: PendingSwap = {
            swapId,
            direction: 'aztec_to_base',
            amount,
            hashlockHigh,
            hashlockLow,
            hashlock: hashlockToBytes32(hashlockHigh, hashlockLow),
            userEvmAddress: dstAddress || undefined,
            solverLocked: false,
            userRedeemed: false,
            solverRedeemed: false,
            createdAt: Date.now(),
          };

          pendingSwaps.set(swapId, swap);

          // Queue lock on Base
          log(`[Aztec] Queueing swap for Base lock (${pendingBaseLocks.length + 1} in queue)`);
          pendingBaseLocks.push(swap);
          processNextBaseLock();
        }

        // Handle TokenRedeemed event (shield flow - user redeemed on Aztec)
        if (eventSig === EVENT_SIG_REDEEMED && fields.length >= 6) {
          const swapId = fields[1].toString();
          const secretHigh = fields[4].toBigInt();
          const secretLow = fields[5].toBigInt();

          const swap = pendingSwaps.get(swapId);
          if (swap && swap.direction === 'base_to_aztec' && swap.solverLocked && !swap.userRedeemed) {
            log(`[Aztec] TokenRedeemed detected for swap ${swapId}`);
            const secret = secretToUint256(secretHigh, secretLow);
            swap.userRedeemed = true;
            await redeemOnBase(swap, secret);
          }
        }

      } catch (parseErr) {
        // Skip malformed logs
      }
    }

    // Also check pending shield swaps for redemption (fallback to HTLC state check)
    for (const [swapId, swap] of pendingSwaps.entries()) {
      if (swap.direction === 'base_to_aztec' && swap.solverLocked && !swap.userRedeemed) {
        try {
          const htlc = await solverTrain.methods
            .get_htlc(Fr.fromString(swapIdToBytes32(swapId)), 0n)
            .simulate({ from: solverAccount.address });

          if (htlc.claimed === 3n) {
            const secretHigh = BigInt(htlc.secret_high);
            const secretLow = BigInt(htlc.secret_low);
            const secret = secretToUint256(secretHigh, secretLow);

            swap.userRedeemed = true;
            await redeemOnBase(swap, secret);
          }
        } catch (err) {
          // HTLC might not exist yet
        }
      }
    }

    aztecLastProcessedBlock = currentBlock;

  } catch (err) {
    log('[Aztec] Error polling events:', err);
  }
}

// ==================== HTTP API ====================

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`);
    const path = url.pathname;

    try {
      // GET /health - Health check
      if (path === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', pendingSwaps: pendingSwaps.size }));
        return;
      }

      // GET /info - Solver info (addresses, balances)
      if (path === '/info' && req.method === 'GET') {
        const evmBalance = await baseToken.balanceOf(evmSolverWallet.address);
        const aztecBalance = await solverToken.methods
          .balance_of_public(solverAccount.address)
          .simulate({ from: solverAccount.address });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          solverEvmAddress: evmSolverWallet.address,
          solverAztecAddress: solverAccount.address.toString(),
          evmBalance: evmBalance.toString(),
          aztecBalance: aztecBalance.toString(),
          baseTrainAddress: BASE_TRAIN_ADDRESS,
          aztecTrainAddress: AZTEC_TRAIN_ADDRESS,
          baseTokenAddress: BASE_TOKEN_ADDRESS,
          aztecTokenAddress: AZTEC_TOKEN_ADDRESS,
        }));
        return;
      }

      // GET /swaps - List all pending swaps
      if (path === '/swaps' && req.method === 'GET') {
        const swaps = Array.from(pendingSwaps.entries()).map(([id, swap]) => ({
          swapId: id,
          direction: swap.direction,
          amount: swap.amount.toString(),
          solverLocked: swap.solverLocked,
          userRedeemed: swap.userRedeemed,
          solverRedeemed: swap.solverRedeemed,
          createdAt: swap.createdAt,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ swaps }));
        return;
      }

      // GET /swap/:id - Get specific swap status
      if (path.startsWith('/swap/') && req.method === 'GET') {
        const swapId = path.slice(6);
        const swap = pendingSwaps.get(swapId);

        if (!swap) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Swap not found' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          swapId,
          direction: swap.direction,
          amount: swap.amount.toString(),
          hashlock: swap.hashlock,
          solverLocked: swap.solverLocked,
          userRedeemed: swap.userRedeemed,
          solverRedeemed: swap.solverRedeemed,
          createdAt: swap.createdAt,
        }));
        return;
      }

      // POST /quote - Get a quote for a swap
      if (path === '/quote' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        await new Promise(resolve => req.on('end', resolve));

        const { direction, amount } = JSON.parse(body);
        const amountBigInt = BigInt(amount);

        // Simple 1:1 rate for now (same token on both chains)
        // In production, would account for gas costs, liquidity, etc.
        const outputAmount = amountBigInt;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          inputAmount: amount,
          outputAmount: outputAmount.toString(),
          direction,
          solverEvmAddress: evmSolverWallet.address,
          solverAztecAddress: solverAccount.address.toString(),
          timelockSeconds: TIMELOCK_BUFFER,
        }));
        return;
      }

      // POST /notify-lock - Notify solver of a user lock (alternative to event detection)
      if (path === '/notify-lock' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        await new Promise(resolve => req.on('end', resolve));

        const { swapId: rawSwapId, direction, amount, hashlockHigh, hashlockLow, userAddress } = JSON.parse(body);

        // Convert decimal swapId to hex bytes32 format (matching EVM event format)
        const swapId = '0x' + BigInt(rawSwapId).toString(16).padStart(64, '0');

        // Check if already tracked
        if (pendingSwaps.has(swapId)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'already_tracking', swapId }));
          return;
        }

        log(`[HTTP] Received lock notification for swap ${swapId}`);

        const swap: PendingSwap = {
          swapId,
          direction,
          amount: BigInt(amount),
          hashlockHigh: BigInt(hashlockHigh),
          hashlockLow: BigInt(hashlockLow),
          hashlock: hashlockToBytes32(BigInt(hashlockHigh), BigInt(hashlockLow)),
          userEvmAddress: direction === 'aztec_to_base' ? userAddress : undefined,
          userAztecAddress: direction === 'base_to_aztec' ? userAddress : undefined,
          solverLocked: false,
          userRedeemed: false,
          solverRedeemed: false,
          createdAt: Date.now(),
        };
        pendingSwaps.set(swapId, swap);

        // Queue counter-lock
        if (direction === 'aztec_to_base') {
          pendingBaseLocks.push(swap);
          processNextBaseLock();
        } else {
          pendingAztecLocks.push(swap);
          processNextAztecLock();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted', swapId }));
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err: any) {
      log('[HTTP] Error handling request:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(HTTP_PORT, () => {
    log(`HTTP API listening on port ${HTTP_PORT}`);
    log(`  GET  /health       - Health check`);
    log(`  GET  /info         - Solver addresses and balances`);
    log(`  GET  /swaps        - List pending swaps`);
    log(`  GET  /swap/:id     - Get swap status`);
    log(`  POST /quote        - Get swap quote`);
    log(`  POST /notify-lock  - Notify solver of user lock`);
  });

  return server;
}

// ==================== MAIN LOOP ====================

async function main() {
  console.log('='.repeat(60));
  console.log('zkzkp2p Minimal Solver');
  console.log('='.repeat(60));
  console.log('');

  // Validate config
  const required = [
    'AZTEC_SOLVER_SECRET_KEY',
    'AZTEC_SOLVER_SALT',
    'AZTEC_SOLVER_SIGNING_KEY',
    'EVM_SOLVER_PRIVATE_KEY',
    'AZTEC_TRAIN_ADDRESS',
    'AZTEC_TOKEN_ADDRESS',
    'BASE_TRAIN_ADDRESS',
    'BASE_TOKEN_ADDRESS',
  ];

  for (const key of required) {
    if (!process.env[key]) {
      console.error(`Missing required env var: ${key}`);
      process.exit(1);
    }
  }

  // Setup connections
  await setupAztec();
  await setupEvm();

  // Start HTTP API
  startHttpServer();

  console.log('');
  console.log('Solver is running. Listening for events...');
  console.log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
  console.log('');

  // Setup EVM event listeners (disabled - public RPCs don't support persistent filters well)
  // The solver uses polling (pollEvmEvents) instead for reliability
  // trainErc20.on('TokenLocked', async (Id, hashlock, dstChain, dstAddress, dstAsset, sender, srcReceiver, srcAsset, amount, reward, rewardTimelock, timelock, tokenContract, event) => {
  //   await handleEvmTokenLocked(event as ethers.EventLog);
  // });

  // trainErc20.on('TokenRedeemed', async (Id, redeemAddress, secret, hashlock, event) => {
  //   await handleEvmTokenRedeemed(event as ethers.EventLog);
  // });

  // Main polling loop (for Aztec and catch-up)
  while (true) {
    try {
      updateStatusLine();
      await pollAztecEvents();
      await pollEvmEvents(); // Also poll EVM as backup

    } catch (err) {
      log('Error in main loop:', err);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

main().catch(err => {
  console.error('Solver crashed:', err);
  process.exit(1);
});
