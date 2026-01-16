/**
 * zkzkp2p Bridge Configuration
 *
 * App-specific settings only. Gateway addresses and protocol constants
 * are imported directly from @substancelabs/aztec-evm-bridge-sdk.
 */

import type { Hex } from 'viem'
import { baseSepolia } from 'viem/chains'

// Re-export SDK constants for convenience
export {
  aztecSepolia,
  gatewayAddresses,
  forwarderAddresses,
  opStackAnchorRegistryAddresses,
  ORDER_DATA_TYPE,
  REFUND_ORDER_TYPE,
  SETTLE_ORDER_TYPE,
  PUBLIC_ORDER,
  PRIVATE_ORDER,
  OPENED,
  FILLED,
  FILLED_PRIVATELY,
  AZTEC_VERSION,
  PRIVATE_SENDER,
} from '@substancelabs/aztec-evm-bridge-sdk'

// =============================================================================
// Chain Configuration (app-specific)
// =============================================================================

// Base chain config with viem chain object
export const BASE_CHAIN = {
  id: baseSepolia.id, // 84532
  name: 'Base Sepolia',
  rpcUrl: process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://sepolia.base.org',
  viemChain: baseSepolia,
} as const

// =============================================================================
// Token Configuration (app-specific - varies per deployment)
// =============================================================================

export const TOKENS = {
  aztec: {
    address: (process.env.NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS || '') as Hex,
    symbol: 'USDC',
    decimals: 6,
  },
  base: {
    address: (process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || '') as Hex,
    symbol: 'USDC',
    decimals: 6,
  },
} as const

// =============================================================================
// Timing Configuration (app-specific)
// =============================================================================

export const TIMING = {
  // Polling intervals
  fillerPollIntervalMs: 5000, // 5 seconds
  balancePollIntervalMs: 30000, // 30 seconds

  // Timeouts
  maxWaitForFillerMs: 300000, // 5 minutes
  aztecTxTimeoutMs: 120000, // 2 minutes

  // Default fill deadline (2 hours from now)
  defaultFillDeadlineSeconds: 7200,
} as const

// =============================================================================
// Validation
// =============================================================================

export function isConfigured(): boolean {
  return !!(TOKENS.aztec.address && TOKENS.base.address)
}

export function logConfig(): void {
  console.log('[Substance Bridge] Configuration:')
  console.log('  Aztec Token:', TOKENS.aztec.address || '(not set)')
  console.log('  Base Token:', TOKENS.base.address || '(not set)')
  console.log('  Configured:', isConfigured())
}
