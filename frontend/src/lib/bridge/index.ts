/**
 * Substance Bridge Integration
 *
 * Wrapper around @substancelabs/aztec-evm-bridge-sdk for zkzkp2p.
 */

// Re-export SDK types and utilities
export {
  Bridge,
  getAztecAddressFromAzguardAccount,
  hexToUintArray,
  OrderDataEncoder,
} from '@substancelabs/aztec-evm-bridge-sdk'

export type {
  Order,
  OrderData,
  OrderResult,
  OrderCallbacks,
  ResolvedOrder,
  FilledLog,
  SwapMode,
  BridgeConfigs,
} from '@substancelabs/aztec-evm-bridge-sdk'

// Re-export our local config, types, and balance functions
export * from './config'
export * from './types'
export * from './balances'

// =============================================================================
// Helper Functions for zkzkp2p flows
// =============================================================================

import { Bridge } from '@substancelabs/aztec-evm-bridge-sdk'
import { aztecSepolia } from '@substancelabs/aztec-evm-bridge-sdk'
import { TOKENS, BASE_CHAIN, TIMING } from './config'
import type { AzguardClient } from '@azguardwallet/client'
import type { Hex } from 'viem'
import type { BridgeFlowState } from './types'
import { padHex } from 'viem'
import { baseSepolia } from 'viem/chains'

/**
 * Create a Bridge instance configured for zkzkp2p
 */
export async function createBridge(params: {
  azguardClient?: AzguardClient
  evmProvider?: any
}): Promise<Bridge> {
  const { azguardClient, evmProvider } = params

  return Bridge.create({
    // Cast to any: SDK bundled types reference older @azguardwallet/client version
    azguardClient: azguardClient as any,
    evmProvider,
  })
}

/**
 * Execute deposit flow: Aztec -> Base
 *
 * Opens an order on Aztec to receive USDC on Base.
 * Returns when the order is filled and claimed.
 */
export async function executeDeposit(params: {
  bridge: Bridge
  amount: bigint
  recipientAddress: Hex // EVM address to receive on Base
  onProgress?: (state: Partial<BridgeFlowState>) => void
}): Promise<{ orderId: Hex; txHash: Hex }> {
  const { bridge, amount, recipientAddress, onProgress } = params

  onProgress?.({ status: 'opening' })

  const result = await bridge.openOrder(
    {
      chainIdIn: aztecSepolia.id,
      chainIdOut: BASE_CHAIN.id,
      amountIn: amount,
      amountOut: amount, // 1:1 for same token
      tokenIn: padHex(TOKENS.aztec.address, { size: 32 }),
      tokenOut: padHex(TOKENS.base.address, { size: 32 }),
      recipient: padHex(recipientAddress, { size: 32 }),
      mode: 'private',
      data: padHex('0x', { size: 32 }),
      fillDeadline: Math.floor(Date.now() / 1000) + TIMING.defaultFillDeadlineSeconds,
    },
    {
      onOrderOpened: ({ orderId, transactionHash }) => {
        onProgress?.({
          status: 'waiting_filler',
          orderId,
          txHashes: { open: transactionHash },
        })
      },
      onOrderFilled: ({ orderId, transactionHash }) => {
        onProgress?.({
          status: 'claiming',
          txHashes: { fill: transactionHash },
        })
      },
    }
  )

  onProgress?.({
    status: 'completed',
    txHashes: {
      open: result.orderOpenedTxHash,
      fill: result.orderFilledTxHash,
      claim: result.orderClaimedTxHash,
    },
  })

  return {
    orderId: result.resolvedOrder.orderId,
    txHash: result.orderOpenedTxHash,
  }
}

/**
 * Execute shield flow: Base -> Aztec
 *
 * Opens an order on Base to receive private USDC on Aztec.
 * Returns when the order is filled and claimed.
 */
export async function executeShield(params: {
  bridge: Bridge
  amount: bigint
  aztecRecipient: Hex // Aztec address (32 bytes)
  onProgress?: (state: Partial<BridgeFlowState>) => void
}): Promise<{ orderId: Hex; txHash: Hex; secret?: Hex }> {
  const { bridge, amount, aztecRecipient, onProgress } = params

  let secret: Hex | undefined

  onProgress?.({ status: 'opening' })

  const result = await bridge.openOrder(
    {
      chainIdIn: baseSepolia.id,
      chainIdOut: aztecSepolia.id,
      amountIn: amount,
      amountOut: amount, // 1:1 for same token
      // Don't pad tokenIn - SDK uses it directly for ERC20 calls before padding internally
      tokenIn: TOKENS.base.address,
      tokenOut: padHex(TOKENS.aztec.address, { size: 32 }),
      recipient: aztecRecipient, // Already padded Aztec address
      mode: 'private',
      data: padHex('0x', { size: 32 }),
      fillDeadline: Math.floor(Date.now() / 1000) + TIMING.defaultFillDeadlineSeconds,
    },
    {
      onSecret: ({ secret: s }) => {
        secret = s
      },
      onOrderOpened: ({ orderId, transactionHash }) => {
        onProgress?.({
          status: 'waiting_filler',
          orderId,
          txHashes: { open: transactionHash },
        })
      },
      onOrderFilled: ({ orderId, transactionHash }) => {
        onProgress?.({
          status: 'claiming',
          txHashes: { fill: transactionHash },
        })
      },
    }
  )

  onProgress?.({
    status: 'completed',
    txHashes: {
      open: result.orderOpenedTxHash,
      claim: result.orderClaimedTxHash,
    },
  })

  return {
    orderId: result.resolvedOrder.orderId,
    txHash: result.orderOpenedTxHash,
    secret,
  }
}

/**
 * Format token amount for display (6 decimals for USDC)
 */
export function formatTokenAmount(amount: bigint, decimals: number = 6): string {
  const divisor = BigInt(10 ** decimals)
  const whole = amount / divisor
  const fraction = amount % divisor
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 2)
  return `${whole}.${fractionStr}`
}

/**
 * Parse token amount from string (6 decimals for USDC)
 */
export function parseTokenAmount(amount: string, decimals: number = 6): bigint {
  const [whole, fraction = ''] = amount.split('.')
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals)
  return BigInt(whole || '0') * BigInt(10 ** decimals) + BigInt(paddedFraction)
}
