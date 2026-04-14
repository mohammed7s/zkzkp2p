/**
 * Flow Recovery
 * Checks on-chain state to recover/resume interrupted flows
 */

import type { AzguardClient } from '@azguardwallet/client';
import type { PublicClient } from 'viem';
import { simulateAzguardView } from '../aztec/azguardHelpers';
import { getHTLCDetails, isHTLCPending, isHTLCRedeemed } from './evm';
import {
  AZTEC_TRAIN_ADDRESS,
  AZTEC_TRAIN_METHODS,
  BASE_TRAIN_ADDRESS,
} from './contracts';
import type { ShieldFlowState, ShieldStatus } from './shield';
import type { DepositFlowState, DepositStatus } from './deposit';

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

export interface OnChainStatus {
  // Base chain
  baseHTLCExists: boolean;
  baseHTLCRedeemed: boolean;
  baseHTLCRefunded: boolean;

  // Aztec chain
  aztecHTLCExists: boolean;
  aztecHTLCRedeemed: boolean;
  aztecHTLCRefunded: boolean;
}

export interface RecoveryResult {
  canResume: boolean;
  suggestedStatus: ShieldStatus | DepositStatus;
  onChainStatus: OnChainStatus;
  message: string;
}

// ==================== ON-CHAIN QUERIES ====================

/**
 * Check Base HTLC status
 */
async function checkBaseHTLC(
  publicClient: PublicClient,
  swapId: bigint
): Promise<{ exists: boolean; redeemed: boolean; refunded: boolean }> {
  if (!BASE_TRAIN_ADDRESS) {
    return { exists: false, redeemed: false, refunded: false };
  }

  try {
    const details = await getHTLCDetails(publicClient, swapId);
    if (!details) {
      return { exists: false, redeemed: false, refunded: false };
    }

    return {
      exists: true,
      redeemed: details.claimed === 1,
      refunded: details.claimed === 2,
    };
  } catch (error) {
    console.error('[Recovery] Failed to check Base HTLC:', error);
    return { exists: false, redeemed: false, refunded: false };
  }
}

/**
 * Check Aztec HTLC status
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
async function checkAztecHTLC(
  client: AzguardClient,
  caipAccount: string,
  swapId: string
): Promise<{ exists: boolean; redeemed: boolean; refunded: boolean }> {
  if (!AZTEC_TRAIN_ADDRESS) {
    return { exists: false, redeemed: false, refunded: false };
  }

  try {
    const result = await simulateAzguardView(
      client,
      caipAccount,  // CAIP format for Azguard operation
      AZTEC_TRAIN_ADDRESS,
      AZTEC_TRAIN_METHODS.get_htlc,
      [swapId, '0']
    );

    if (!result) {
      return { exists: false, redeemed: false, refunded: false };
    }

    // Parse HTLC status from result
    // The exact structure depends on the contract return type
    const claimed = result.claimed || result[6] || 0;
    return {
      exists: true,
      redeemed: Number(claimed) === 1,
      refunded: Number(claimed) === 2,
    };
  } catch (error) {
    console.error('[Recovery] Failed to check Aztec HTLC:', error);
    return { exists: false, redeemed: false, refunded: false };
  }
}

// ==================== SHIELD FLOW RECOVERY ====================

/**
 * Recover shield flow state from on-chain data
 * Shield flow: Base lock → Aztec lock (solver) → Aztec redeem (user) → Base redeem (solver)
 * @param aztecCaipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function recoverShieldFlow(
  publicClient: PublicClient,
  azguardClient: AzguardClient,
  aztecCaipAccount: string,
  flow: ShieldFlowState
): Promise<RecoveryResult> {
  const swapId = BigInt(flow.swapId);

  // Check both chains
  const baseStatus = await checkBaseHTLC(publicClient, swapId);
  const aztecStatus = await checkAztecHTLC(azguardClient, aztecCaipAccount, flow.swapId);

  const onChainStatus: OnChainStatus = {
    baseHTLCExists: baseStatus.exists,
    baseHTLCRedeemed: baseStatus.redeemed,
    baseHTLCRefunded: baseStatus.refunded,
    aztecHTLCExists: aztecStatus.exists,
    aztecHTLCRedeemed: aztecStatus.redeemed,
    aztecHTLCRefunded: aztecStatus.refunded,
  };

  // Determine recovery status based on on-chain state
  // Shield: User locks Base → Solver locks Aztec → User redeems Aztec → Solver redeems Base

  if (aztecStatus.redeemed) {
    // User already redeemed on Aztec - flow complete from user's perspective
    return {
      canResume: false,
      suggestedStatus: 'COMPLETE',
      onChainStatus,
      message: 'Shield complete! You have received private tokens on Aztec.',
    };
  }

  if (aztecStatus.exists && !aztecStatus.redeemed) {
    // Solver locked on Aztec, user needs to redeem
    return {
      canResume: true,
      suggestedStatus: 'REDEEMING_AZTEC',
      onChainStatus,
      message: 'Solver has locked on Aztec. You can now redeem your private tokens.',
    };
  }

  if (baseStatus.exists && !baseStatus.redeemed && !aztecStatus.exists) {
    // User locked on Base, waiting for solver
    return {
      canResume: true,
      suggestedStatus: 'WAITING_SOLVER',
      onChainStatus,
      message: 'Your tokens are locked on Base. Waiting for solver to lock on Aztec.',
    };
  }

  if (baseStatus.refunded) {
    // Base HTLC was refunded (timeout)
    return {
      canResume: false,
      suggestedStatus: 'ERROR',
      onChainStatus,
      message: 'Shield failed - Base lock was refunded due to timeout.',
    };
  }

  if (!baseStatus.exists) {
    // No Base lock found - flow never started or was cleared
    return {
      canResume: false,
      suggestedStatus: 'IDLE',
      onChainStatus,
      message: 'No active shield flow found on-chain.',
    };
  }

  return {
    canResume: false,
    suggestedStatus: 'ERROR',
    onChainStatus,
    message: 'Unknown flow state. Please check transaction history.',
  };
}

// ==================== DEPOSIT FLOW RECOVERY ====================

/**
 * Recover deposit flow state from on-chain data
 * Deposit flow: Aztec lock → Base lock (solver) → Base redeem (user) → zkp2p deposit → Aztec redeem (solver)
 * @param aztecCaipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function recoverDepositFlow(
  publicClient: PublicClient,
  azguardClient: AzguardClient,
  aztecCaipAccount: string,
  flow: DepositFlowState
): Promise<RecoveryResult> {
  const swapId = BigInt(flow.swapId);

  // Check both chains
  const aztecStatus = await checkAztecHTLC(azguardClient, aztecCaipAccount, flow.swapId);
  const baseStatus = await checkBaseHTLC(publicClient, swapId);

  const onChainStatus: OnChainStatus = {
    baseHTLCExists: baseStatus.exists,
    baseHTLCRedeemed: baseStatus.redeemed,
    baseHTLCRefunded: baseStatus.refunded,
    aztecHTLCExists: aztecStatus.exists,
    aztecHTLCRedeemed: aztecStatus.redeemed,
    aztecHTLCRefunded: aztecStatus.refunded,
  };

  // Determine recovery status based on on-chain state
  // Deposit: User locks Aztec → Solver locks Base → User redeems Base → User creates zkp2p deposit

  if (baseStatus.redeemed) {
    // User redeemed on Base - need to create zkp2p deposit
    if (flow.zkp2pDepositId) {
      return {
        canResume: false,
        suggestedStatus: 'COMPLETE',
        onChainStatus,
        message: 'Deposit complete! Your zkp2p deposit is active.',
      };
    }
    return {
      canResume: true,
      suggestedStatus: 'CREATING_DEPOSIT',
      onChainStatus,
      message: 'You have redeemed on Base. Now create your zkp2p deposit.',
    };
  }

  if (baseStatus.exists && !baseStatus.redeemed) {
    // Solver locked on Base, user can redeem
    return {
      canResume: true,
      suggestedStatus: 'REDEEMING_BASE',
      onChainStatus,
      message: 'Solver has locked on Base. You can now redeem your tokens.',
    };
  }

  if (aztecStatus.exists && !aztecStatus.redeemed && !baseStatus.exists) {
    // User locked on Aztec, waiting for solver
    return {
      canResume: true,
      suggestedStatus: 'WAITING_SOLVER',
      onChainStatus,
      message: 'Your tokens are locked on Aztec. Waiting for solver to lock on Base.',
    };
  }

  if (aztecStatus.refunded) {
    // Aztec HTLC was refunded (timeout)
    return {
      canResume: false,
      suggestedStatus: 'ERROR',
      onChainStatus,
      message: 'Deposit failed - Aztec lock was refunded due to timeout.',
    };
  }

  if (!aztecStatus.exists) {
    // No Aztec lock found
    return {
      canResume: false,
      suggestedStatus: 'IDLE',
      onChainStatus,
      message: 'No active deposit flow found on-chain.',
    };
  }

  return {
    canResume: false,
    suggestedStatus: 'ERROR',
    onChainStatus,
    message: 'Unknown flow state. Please check transaction history.',
  };
}
