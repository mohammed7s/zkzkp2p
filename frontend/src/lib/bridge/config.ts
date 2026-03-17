/**
 * zkzkp2p Bridge Configuration
 *
 * App-specific settings only. Gateway addresses and protocol constants
 * are imported directly from @substancelabs/aztec-evm-bridge-sdk.
 */

import type { Hex } from 'viem'
import {
  BASE_CHAIN as APP_BASE_CHAIN,
  BASE_NETWORK,
  CHAINS,
  CONTRACTS,
  TIMING as APP_TIMING,
} from '@/config'

// Re-export SDK constants for convenience
export {
  aztecSepolia,
  chainsConfig,
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

// Base chain config with viem chain object from the app-wide network selection
export const BASE_CHAIN = {
  id: APP_BASE_CHAIN.id,
  name: APP_BASE_CHAIN.name,
  rpcUrl: CHAINS.base.rpcUrl,
  viemChain: APP_BASE_CHAIN,
} as const

// =============================================================================
// Token Configuration (app-specific - varies per deployment)
// =============================================================================

export const TOKENS = {
  aztec: {
    address: CONTRACTS.aztec.token as Hex,
    symbol: 'USDC',
    decimals: 6,
  },
  base: {
    address: CONTRACTS.base.token as Hex,
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
  balancePollIntervalMs: APP_TIMING.balancePollInterval,

  // Timeouts
  maxWaitForFillerMs: APP_TIMING.solverMaxWait,
  aztecTxTimeoutMs: 120000, // 2 minutes

  // Default fill deadline (2 hours from now)
  defaultFillDeadlineSeconds: APP_TIMING.defaultTimelockSeconds,
} as const

// =============================================================================
// Validation
// =============================================================================

export function isConfigured(): boolean {
  return !!(TOKENS.aztec.address && TOKENS.base.address)
}

export function logConfig(): void {
  console.log('[Substance Bridge] Configuration:')
  console.log('  Base Network:', BASE_NETWORK)
  console.log('  Base Chain ID:', BASE_CHAIN.id)
  console.log('  Aztec Token:', TOKENS.aztec.address || '(not set)')
  console.log('  Base Token:', TOKENS.base.address || '(not set)')
  console.log('  Configured:', isConfigured())
}
