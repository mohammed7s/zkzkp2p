/**
 * Shield Flow: Base → Aztec (private)
 *
 * Flow:
 * 1. User generates secret & hashlock
 * 2. User locks on Base (Train ERC20)
 * 3. Solver monitors and locks on Aztec (lock_dst)
 * 4. User redeems on Aztec (reveals secret, gets private balance)
 * 5. Solver redeems on Base (using revealed secret)
 */

import type { AzguardClient } from '@azguardwallet/client';
import type { WalletClient, PublicClient, Hash } from 'viem';
import { generateSecretAndHashlock, generateSwapId } from '../crypto';
import { lockOnBase, getBaseUSDCBalance, getHTLCDetails, type LockParams } from './evm';
import { executeAzguardCall, executeAzguardBatch, simulateAzguardView } from '../aztec/azguardHelpers';
import {
  AZTEC_TRAIN_ADDRESS,
  AZTEC_TOKEN_ADDRESS,
  AZTEC_TRAIN_METHODS,
  AZTEC_TOKEN_METHODS,
  DEFAULT_TIMELOCK_SECONDS,
} from './contracts';

// ==================== CAIP HELPERS ====================

/**
 * Extract plain address from CAIP account format
 * CAIP format: "aztec:1674512022:0x..." → "0x..."
 */
function extractAddressFromCaip(caipAccount: string): string {
  const parts = caipAccount.split(':');
  return parts[parts.length - 1];
}

// ==================== TYPES ====================

export interface ShieldFlowState {
  status: ShieldStatus;
  swapId: string;
  amount: bigint;
  secretHigh: bigint;
  secretLow: bigint;
  hashlockHigh: bigint;
  hashlockLow: bigint;
  baseLockTxHash?: string;
  aztecLockTxHash?: string; // Solver's lock on Aztec
  aztecRedeemTxHash?: string;
  error?: string;
}

export type ShieldStatus =
  | 'IDLE'
  | 'GENERATING_SECRET'
  | 'APPROVING_BASE'
  | 'LOCKING_BASE'
  | 'WAITING_SOLVER'
  | 'REDEEMING_AZTEC'
  | 'COMPLETE'
  | 'ERROR';

// ==================== FLOW FUNCTIONS ====================

/**
 * Initialize a new shield flow
 */
export async function initShieldFlow(amount: bigint): Promise<ShieldFlowState> {
  const { secretHigh, secretLow, hashlockHigh, hashlockLow } = await generateSecretAndHashlock();
  const swapId = generateSwapId();

  return {
    status: 'GENERATING_SECRET',
    swapId: swapId.toString(),
    amount,
    secretHigh,
    secretLow,
    hashlockHigh,
    hashlockLow,
  };
}

/**
 * Step 1: Lock tokens on Base via Train contract
 */
export async function lockOnBaseForShield(
  walletClient: WalletClient,
  publicClient: PublicClient,
  userAddress: `0x${string}`,
  aztecAddress: string,
  solverAddress: `0x${string}`, // Solver's EVM address to receive refund
  flow: ShieldFlowState
): Promise<Hash> {
  const lockParams: LockParams = {
    swapId: BigInt(flow.swapId),
    hashlockHigh: flow.hashlockHigh,
    hashlockLow: flow.hashlockLow,
    timelockSeconds: DEFAULT_TIMELOCK_SECONDS,
    srcReceiver: solverAddress, // Solver gets this if they complete the swap
    dstChain: 'AZTEC',
    dstAddress: aztecAddress, // User's Aztec address to receive private tokens
    amount: flow.amount,
  };

  return lockOnBase(walletClient, publicClient, lockParams);
}

/**
 * Step 2: Wait for solver to lock on Aztec
 * Returns the swap ID if found on Aztec
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function checkAztecLock(
  client: AzguardClient,
  caipAccount: string,
  swapId: string
): Promise<any | null> {
  if (!AZTEC_TRAIN_ADDRESS) {
    throw new Error('Train address not configured');
  }

  try {
    const result = await simulateAzguardView(
      client,
      caipAccount,  // CAIP format for Azguard operation
      AZTEC_TRAIN_ADDRESS,
      AZTEC_TRAIN_METHODS.get_htlc,
      [swapId, '0']
    );
    return result;
  } catch (error) {
    console.log('[Shield] HTLC not found on Aztec yet');
    return null;
  }
}

/**
 * Poll for Aztec lock from solver
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function waitForAztecLock(
  client: AzguardClient,
  caipAccount: string,
  swapId: string,
  timeoutMs: number = 300000, // 5 minutes default
  pollIntervalMs: number = 5000
): Promise<any> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const htlc = await checkAztecLock(client, caipAccount, swapId);
    if (htlc) {
      console.log('[Shield] Found HTLC on Aztec:', htlc);
      return htlc;
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error('Timeout waiting for solver to lock on Aztec');
}

/**
 * Step 3: Redeem on Aztec (reveals secret, user gets PUBLIC balance)
 * Note: Call transferToPrivate separately to move to private balance
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function redeemOnAztec(
  client: AzguardClient,
  caipAccount: string,
  flow: ShieldFlowState
): Promise<string> {
  if (!AZTEC_TRAIN_ADDRESS) {
    throw new Error('Train address not configured');
  }

  const txHash = await executeAzguardCall(
    client,
    caipAccount,
    AZTEC_TRAIN_ADDRESS,
    AZTEC_TRAIN_METHODS.redeem,
    [
      flow.swapId,
      '0', // htlc_id=0 for solver-created locks in shield flow
      flow.secretHigh.toString(),
      flow.secretLow.toString(),
    ]
  );

  return txHash;
}

/**
 * Step 3b: Transfer redeemed tokens from public to private
 * Call this after redeemOnAztec to get private balance
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function transferToPrivateAfterRedeem(
  client: AzguardClient,
  caipAccount: string,
  amount: bigint
): Promise<string> {
  if (!AZTEC_TOKEN_ADDRESS) {
    throw new Error('Token address not configured');
  }

  const userAddress = extractAddressFromCaip(caipAccount);

  const txHash = await executeAzguardCall(
    client,
    caipAccount,
    AZTEC_TOKEN_ADDRESS,
    AZTEC_TOKEN_METHODS.transfer_to_private,
    [userAddress, amount.toString()]
  );

  return txHash;
}

/**
 * Step 3 Combined: Redeem on Aztec AND transfer to private in a single tx
 * This batches both operations so user only confirms once
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function redeemAndTransferToPrivate(
  client: AzguardClient,
  caipAccount: string,
  flow: ShieldFlowState
): Promise<string> {
  if (!AZTEC_TRAIN_ADDRESS || !AZTEC_TOKEN_ADDRESS) {
    throw new Error('Contract addresses not configured');
  }

  const userAddress = extractAddressFromCaip(caipAccount);

  // Batch both operations: redeem + transfer_to_private
  const txHash = await executeAzguardBatch(
    client,
    caipAccount,
    [
      // First: redeem from Train contract (tokens go to public balance)
      {
        contract: AZTEC_TRAIN_ADDRESS,
        method: AZTEC_TRAIN_METHODS.redeem,
        args: [
          flow.swapId,
          '0', // htlc_id=0 for solver-created locks
          flow.secretHigh.toString(),
          flow.secretLow.toString(),
        ],
      },
      // Second: transfer from public to private
      {
        contract: AZTEC_TOKEN_ADDRESS,
        method: AZTEC_TOKEN_METHODS.transfer_to_private,
        args: [userAddress, flow.amount.toString()],
      },
    ]
  );

  return txHash;
}

// ==================== BALANCE QUERIES ====================

/**
 * Get user's private balance on Aztec
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function getAztecPrivateBalance(
  client: AzguardClient,
  caipAccount: string
): Promise<bigint> {
  if (!AZTEC_TOKEN_ADDRESS) {
    throw new Error('Token address not configured');
  }

  // Extract plain address for contract args
  const userAddress = extractAddressFromCaip(caipAccount);

  try {
    const result = await simulateAzguardView(
      client,
      caipAccount,  // CAIP format for Azguard operation
      AZTEC_TOKEN_ADDRESS,
      'balance_of_private',
      [userAddress]  // Plain address for contract arg
    );
    return BigInt(result?.toString() || '0');
  } catch (error) {
    console.error('[Shield] Failed to get Aztec balance:', error);
    return 0n;
  }
}

// ==================== FLOW ORCHESTRATION ====================

/**
 * Execute full shield flow with status callbacks
 * @param aztecCaipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function executeShieldFlow(
  walletClient: WalletClient,
  publicClient: PublicClient,
  azguardClient: AzguardClient,
  evmAddress: `0x${string}`,
  aztecCaipAccount: string,
  solverEvmAddress: `0x${string}`,
  amount: bigint,
  onStatusChange: (state: ShieldFlowState) => void
): Promise<ShieldFlowState> {
  let flow: ShieldFlowState;

  // Extract plain address for display/Base dstAddress
  const aztecAddress = extractAddressFromCaip(aztecCaipAccount);

  try {
    // Step 1: Generate secret
    onStatusChange({ status: 'GENERATING_SECRET' } as ShieldFlowState);
    flow = await initShieldFlow(amount);
    onStatusChange(flow);

    // Step 2: Lock on Base
    flow = { ...flow, status: 'LOCKING_BASE' };
    onStatusChange(flow);

    const baseTxHash = await lockOnBaseForShield(
      walletClient,
      publicClient,
      evmAddress,
      aztecAddress,  // Plain address for EVM contract dstAddress
      solverEvmAddress,
      flow
    );

    flow = { ...flow, baseLockTxHash: baseTxHash, status: 'WAITING_SOLVER' };
    onStatusChange(flow);

    // Step 3: Wait for solver to lock on Aztec
    // Note: In production, this would be monitored asynchronously
    const aztecHtlc = await waitForAztecLock(azguardClient, aztecCaipAccount, flow.swapId);
    flow = { ...flow, aztecLockTxHash: 'solver_locked' };
    onStatusChange(flow);

    // Step 4: Redeem on Aztec
    flow = { ...flow, status: 'REDEEMING_AZTEC' };
    onStatusChange(flow);

    const aztecRedeemTx = await redeemOnAztec(azguardClient, aztecCaipAccount, flow);
    flow = { ...flow, aztecRedeemTxHash: aztecRedeemTx, status: 'COMPLETE' };
    onStatusChange(flow);

    return flow;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    flow = { ...flow!, status: 'ERROR', error: errorMessage };
    onStatusChange(flow);
    throw error;
  }
}
