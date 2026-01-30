/**
 * Substance Bridge Types
 *
 * Local types for zkzkp2p integration.
 * Most types are re-exported from the Substance SDK.
 */

import type { Hex, Address, WalletClient, PublicClient } from 'viem'
import type { AzguardClient } from '@azguardwallet/client'

// =============================================================================
// Wallet Context (local type for our flows)
// =============================================================================

export interface WalletContext {
  aztec?: {
    client: AzguardClient
    caipAccount: string
  }
  evm?: {
    walletClient: WalletClient
    publicClient: PublicClient
    address: Address
  }
}

// =============================================================================
// Flow State Types (for UI)
// =============================================================================

export type BridgeStatus =
  | 'idle'
  | 'approving'
  | 'opening'
  | 'waiting_filler'
  | 'claiming'
  | 'completed'
  | 'refunding'
  | 'refunded'
  | 'error'

export interface BridgeFlowState {
  status: BridgeStatus
  orderId?: string
  amount: bigint
  secret?: {
    value: string
    hash: string
  }
  txHashes: {
    open?: string
    fill?: string
    claim?: string
    refund?: string
  }
  error?: string
  createdAt: number
  updatedAt: number

  // Burner info for privacy-preserving deposits (Aztec → Base)
  burner?: {
    nonce: number              // Timestamp nonce for derivation (minute precision)
    smartAccountAddress: string // The smart account address (recipient on Base)
    eoaAddress: string         // The underlying EOA address
  }
}

// =============================================================================
// Direction Types
// =============================================================================

export type BridgeDirection = 'aztec_to_base' | 'base_to_aztec'

export function getDirection(chainIdIn: number, chainIdOut: number): BridgeDirection {
  // Aztec chain ID is 999999
  if (chainIdIn === 999999) return 'aztec_to_base'
  if (chainIdOut === 999999) return 'base_to_aztec'
  throw new Error('Neither chain is Aztec')
}
