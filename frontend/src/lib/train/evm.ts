/**
 * EVM-side Train Protocol functions for Base chain
 *
 * Shield Flow (Base → Aztec): User calls lock() on Base
 * Deposit Flow (Aztec → Base): User calls redeem() on Base
 */

import {
  type WalletClient,
  type PublicClient,
  parseAbi,
  encodeFunctionData,
  type Hash,
} from 'viem';
import {
  BASE_TRAIN_ADDRESS,
  BASE_TOKEN_ADDRESS,
  TRAIN_ERC20_ABI,
  ERC20_ABI,
  TOKEN_DECIMALS,
  SOLVER_API_URL,
} from './contracts';
import { hashlockToBytes32, swapIdToBytes32, secretToUint256 } from '../crypto';

// ==================== TYPES ====================

export interface LockParams {
  swapId: bigint;
  hashlockHigh: bigint;
  hashlockLow: bigint;
  timelockSeconds: number;
  srcReceiver: `0x${string}`; // Who gets refund if fails
  dstChain: string;
  dstAddress: string; // Aztec address to receive
  amount: bigint;
}

export interface HTLCDetails {
  amount: bigint;
  hashlock: `0x${string}`;
  secret: bigint;
  tokenContract: `0x${string}`;
  timelock: number;
  claimed: number; // 0: pending, 1: redeemed, 2: refunded
  sender: `0x${string}`;
  srcReceiver: `0x${string}`;
}

// ==================== TOKEN OPERATIONS ====================

/**
 * Get ERC20 token balance
 */
export async function getTokenBalance(
  publicClient: PublicClient,
  tokenAddress: `0x${string}`,
  userAddress: `0x${string}`
): Promise<bigint> {
  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: parseAbi(ERC20_ABI),
    functionName: 'balanceOf',
    args: [userAddress],
  });
  return balance as bigint;
}

/**
 * Get Base USDC balance (convenience wrapper)
 */
export async function getBaseUSDCBalance(
  publicClient: PublicClient,
  userAddress: `0x${string}`
): Promise<bigint> {
  if (!BASE_TOKEN_ADDRESS) {
    throw new Error('Base token address not configured');
  }
  return getTokenBalance(publicClient, BASE_TOKEN_ADDRESS as `0x${string}`, userAddress);
}

/**
 * Get token allowance
 */
export async function getTokenAllowance(
  publicClient: PublicClient,
  tokenAddress: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`
): Promise<bigint> {
  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: parseAbi(ERC20_ABI),
    functionName: 'allowance',
    args: [owner, spender],
  });
  return allowance as bigint;
}

/**
 * Approve token spending
 */
export async function approveToken(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenAddress: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint
): Promise<Hash> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet not connected');

  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: parseAbi(ERC20_ABI),
    functionName: 'approve',
    args: [spender, amount],
    account,
    chain: walletClient.chain,
  });

  // Wait for confirmation
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Call faucet on mock USDC (testnet only)
 */
export async function callFaucet(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenAddress: `0x${string}`
): Promise<Hash> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet not connected');

  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: parseAbi(ERC20_ABI),
    functionName: 'faucet',
    args: [],
    account,
    chain: walletClient.chain,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// ==================== TRAIN LOCK OPERATIONS ====================

/**
 * Lock tokens on Base via Train contract
 * Used in Shield flow: User initiates Base → Aztec transfer
 */
export async function lockOnBase(
  walletClient: WalletClient,
  publicClient: PublicClient,
  params: LockParams
): Promise<Hash> {
  if (!BASE_TRAIN_ADDRESS || !BASE_TOKEN_ADDRESS) {
    throw new Error('Train contract addresses not configured');
  }

  const account = walletClient.account;
  if (!account) throw new Error('Wallet not connected');

  // Calculate timelock (current timestamp + seconds)
  const currentTime = Math.floor(Date.now() / 1000);
  const timelock = currentTime + params.timelockSeconds;

  // Convert hashlock to bytes32
  const hashlock = hashlockToBytes32(params.hashlockHigh, params.hashlockLow);
  const swapIdBytes = swapIdToBytes32(params.swapId);

  // Build lock params struct
  const lockParams = {
    Id: swapIdBytes,
    hashlock,
    reward: 0n, // No reward for MVP
    rewardTimelock: timelock - 100, // Must be before timelock (contract validation)
    timelock,
    srcReceiver: params.srcReceiver,
    srcAsset: 'USDC',
    dstChain: 'AZTEC_DEVNET', // Match Train contract expected value
    dstAddress: params.dstAddress,
    dstAsset: 'USDC',
    amount: params.amount,
    tokenContract: BASE_TOKEN_ADDRESS as `0x${string}`,
  };

  // First approve if needed
  const allowance = await getTokenAllowance(
    publicClient,
    BASE_TOKEN_ADDRESS as `0x${string}`,
    account.address,
    BASE_TRAIN_ADDRESS as `0x${string}`
  );

  console.log('[EVM] Current allowance:', allowance.toString());
  console.log('[EVM] Amount to lock:', params.amount.toString());

  // Check user balance
  const balance = await getBaseUSDCBalance(publicClient, account.address);
  console.log('[EVM] User USDC balance:', balance.toString());

  if (balance < params.amount) {
    throw new Error(`Insufficient USDC balance. Have: ${balance}, Need: ${params.amount}`);
  }

  if (allowance < params.amount) {
    console.log('[EVM] Insufficient allowance, requesting approval...');
    const approvalHash = await approveToken(
      walletClient,
      publicClient,
      BASE_TOKEN_ADDRESS as `0x${string}`,
      BASE_TRAIN_ADDRESS as `0x${string}`,
      params.amount
    );
    console.log('[EVM] Approval complete:', approvalHash);

    // Verify approval went through
    const newAllowance = await getTokenAllowance(
      publicClient,
      BASE_TOKEN_ADDRESS as `0x${string}`,
      account.address,
      BASE_TRAIN_ADDRESS as `0x${string}`
    );
    console.log('[EVM] New allowance:', newAllowance.toString());

    if (newAllowance < params.amount) {
      throw new Error('Approval failed - please try again');
    }
  } else {
    console.log('[EVM] Sufficient allowance already exists');
  }

  // Execute lock
  console.log('[EVM] Locking tokens on Base...');
  console.log('[EVM] Contract:', BASE_TRAIN_ADDRESS);
  console.log('[EVM] Lock params:', lockParams);

  const hash = await walletClient.writeContract({
    address: BASE_TRAIN_ADDRESS as `0x${string}`,
    abi: TRAIN_ERC20_ABI,  // Already in JSON format
    functionName: 'lock',
    args: [lockParams],
    account,
    chain: walletClient.chain,
  });

  console.log('[EVM] Lock tx submitted:', hash);
  console.log('[EVM] Waiting for confirmation...');

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log('[EVM] Lock confirmed in block:', receipt.blockNumber);
  console.log('[EVM] Transaction status:', receipt.status);

  if (receipt.status === 'reverted') {
    throw new Error('Lock transaction failed - check your USDC balance and approvals');
  }

  return hash;
}

// ==================== TRAIN REDEEM OPERATIONS ====================

/**
 * Redeem tokens on Base by revealing secret
 * Used in Deposit flow: User redeems on Base after solver locks
 */
export async function redeemOnBase(
  walletClient: WalletClient,
  publicClient: PublicClient,
  swapId: bigint,
  secretHigh: bigint,
  secretLow: bigint
): Promise<Hash> {
  if (!BASE_TRAIN_ADDRESS) {
    throw new Error('Train contract address not configured');
  }

  const account = walletClient.account;
  if (!account) throw new Error('Wallet not connected');

  const swapIdBytes = swapIdToBytes32(swapId);
  const secretValue = secretToUint256(secretHigh, secretLow);

  console.log('[EVM] Redeeming tokens on Base...', { swapId: swapIdBytes, secret: secretValue });

  const hash = await walletClient.writeContract({
    address: BASE_TRAIN_ADDRESS as `0x${string}`,
    abi: TRAIN_ERC20_ABI,  // Already in JSON format
    functionName: 'redeem',
    args: [swapIdBytes, secretValue],
    account,
    chain: walletClient.chain,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// ==================== TRAIN REFUND OPERATIONS ====================

/**
 * Refund tokens on Base after timelock expires
 * Can only be called after timelock and if not already redeemed
 * Used when swap fails/times out to recover locked funds
 */
export async function refundOnBase(
  walletClient: WalletClient,
  publicClient: PublicClient,
  swapId: bigint
): Promise<Hash> {
  if (!BASE_TRAIN_ADDRESS) {
    throw new Error('Train contract address not configured');
  }

  const account = walletClient.account;
  if (!account) throw new Error('Wallet not connected');

  const swapIdBytes = swapIdToBytes32(swapId);

  // Check HTLC status first
  const details = await getHTLCDetails(publicClient, swapId);
  if (!details) {
    throw new Error('HTLC not found');
  }

  if (details.claimed === 1) {
    throw new Error('HTLC already redeemed - cannot refund');
  }

  if (details.claimed === 2) {
    throw new Error('HTLC already refunded');
  }

  // Check timelock
  const currentTime = Math.floor(Date.now() / 1000);
  if (currentTime < details.timelock) {
    const remainingSeconds = details.timelock - currentTime;
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    throw new Error(`Timelock not expired. Wait ${minutes}m ${seconds}s before refunding.`);
  }

  console.log('[EVM] Refunding tokens on Base...', { swapId: swapIdBytes });

  const hash = await walletClient.writeContract({
    address: BASE_TRAIN_ADDRESS as `0x${string}`,
    abi: TRAIN_ERC20_ABI,
    functionName: 'refund',
    args: [swapIdBytes],
    account,
    chain: walletClient.chain,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  console.log('[EVM] Refund complete:', hash);
  return hash;
}

/**
 * Check if HTLC can be refunded (timelock expired and not claimed)
 */
export async function canRefund(
  publicClient: PublicClient,
  swapId: bigint
): Promise<{ canRefund: boolean; reason?: string; timeRemaining?: number }> {
  const details = await getHTLCDetails(publicClient, swapId);

  if (!details) {
    return { canRefund: false, reason: 'HTLC not found' };
  }

  if (details.claimed === 1) {
    return { canRefund: false, reason: 'Already redeemed' };
  }

  if (details.claimed === 2) {
    return { canRefund: false, reason: 'Already refunded' };
  }

  const currentTime = Math.floor(Date.now() / 1000);
  if (currentTime < details.timelock) {
    return {
      canRefund: false,
      reason: 'Timelock not expired',
      timeRemaining: details.timelock - currentTime
    };
  }

  return { canRefund: true };
}

// ==================== HTLC QUERIES ====================

/**
 * Get HTLC details from Base Train contract
 */
export async function getHTLCDetails(
  publicClient: PublicClient,
  swapId: bigint
): Promise<HTLCDetails | null> {
  if (!BASE_TRAIN_ADDRESS) {
    throw new Error('Train contract address not configured');
  }

  const swapIdBytes = swapIdToBytes32(swapId);

  try {
    const result = await publicClient.readContract({
      address: BASE_TRAIN_ADDRESS as `0x${string}`,
      abi: TRAIN_ERC20_ABI,  // Already in JSON format
      functionName: 'getHTLCDetails',
      args: [swapIdBytes],
    }) as any;

    return {
      amount: result.amount,
      hashlock: result.hashlock,
      secret: result.secret,
      tokenContract: result.tokenContract,
      timelock: Number(result.timelock),
      claimed: Number(result.claimed),
      sender: result.sender,
      srcReceiver: result.srcReceiver,
    };
  } catch (error) {
    console.error('[EVM] Failed to get HTLC details:', error);
    return null;
  }
}

/**
 * Check if HTLC exists and is pending
 */
export async function isHTLCPending(
  publicClient: PublicClient,
  swapId: bigint
): Promise<boolean> {
  const details = await getHTLCDetails(publicClient, swapId);
  return details !== null && details.claimed === 0;
}

/**
 * Check if HTLC is redeemed
 */
export async function isHTLCRedeemed(
  publicClient: PublicClient,
  swapId: bigint
): Promise<boolean> {
  const details = await getHTLCDetails(publicClient, swapId);
  return details !== null && details.claimed === 1;
}

// ==================== HELPERS ====================

/**
 * Format token amount for display
 */
export function formatTokenAmount(amount: bigint, decimals: bigint = TOKEN_DECIMALS): string {
  const divisor = 10n ** decimals;
  const whole = amount / divisor;
  const fraction = amount % divisor;
  return `${whole}.${fraction.toString().padStart(Number(decimals), '0')}`;
}

/**
 * Parse display amount to raw amount
 */
export function parseTokenAmount(displayAmount: string, decimals: bigint = TOKEN_DECIMALS): bigint {
  const [whole, fraction = ''] = displayAmount.split('.');
  const paddedFraction = fraction.padEnd(Number(decimals), '0').slice(0, Number(decimals));
  return BigInt(whole || '0') * 10n ** decimals + BigInt(paddedFraction);
}

// ==================== SOLVER NOTIFICATION ====================

export type SwapDirection = 'base_to_aztec' | 'aztec_to_base';

export interface NotifySolverParams {
  swapId: string;
  direction: SwapDirection;
  amount: bigint;
  hashlockHigh: bigint;
  hashlockLow: bigint;
  userAddress: string; // Aztec address for base_to_aztec, EVM address for aztec_to_base
}

/**
 * Notify solver of a user lock for faster processing
 * This is optional - solver also polls for events, but this speeds things up
 */
export async function notifySolver(params: NotifySolverParams): Promise<boolean> {
  try {
    console.log('[Solver] Notifying solver of lock:', params.swapId);

    const response = await fetch(`${SOLVER_API_URL}/notify-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        swapId: params.swapId,
        direction: params.direction,
        amount: params.amount.toString(),
        hashlockHigh: params.hashlockHigh.toString(),
        hashlockLow: params.hashlockLow.toString(),
        userAddress: params.userAddress,
      }),
    });

    if (response.ok) {
      const result = await response.json();
      console.log('[Solver] Notification accepted:', result);
      return true;
    } else {
      console.warn('[Solver] Notification failed:', response.status, await response.text());
      return false;
    }
  } catch (error) {
    // Non-fatal - solver will still pick up via event polling
    console.warn('[Solver] Could not notify solver (will retry via events):', error);
    return false;
  }
}
