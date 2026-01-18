/**
 * Balance Query Functions
 * Query EVM and Aztec token balances
 */

import type { PublicClient } from 'viem'
import type { AzguardClient } from '@azguardwallet/client'
import { TOKENS } from './config'
import { simulateAzguardView } from '../aztec/azguardHelpers'

// ERC20 ABI for balance queries
const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const

// Aztec token method selectors (simple names - Azguard resolves the full signature)
const AZTEC_TOKEN_METHODS = {
  balance_of_private: 'balance_of_private',
  balance_of_public: 'balance_of_public',
}

/**
 * Get ERC20 token balance on Base
 */
export async function getBaseUSDCBalance(
  publicClient: PublicClient,
  userAddress: `0x${string}`
): Promise<bigint> {
  if (!TOKENS.base.address) {
    throw new Error('Base token address not configured')
  }

  const balance = await publicClient.readContract({
    address: TOKENS.base.address as `0x${string}`,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [userAddress],
  })

  return balance as bigint
}

/**
 * Extract plain address from CAIP format
 * aztec:999999:0x123... -> 0x123...
 */
function extractAddressFromCaip(caipAccount: string): string {
  const parts = caipAccount.split(':')
  return parts[parts.length - 1]
}

/**
 * Get private USDC balance on Aztec
 */
export async function getAztecPrivateBalance(
  client: AzguardClient,
  caipAccount: string
): Promise<bigint | null> {
  if (!TOKENS.aztec.address) {
    console.error('[Aztec] AZTEC_TOKEN_ADDRESS not configured!')
    throw new Error('Token address not configured')
  }

  const userAddress = extractAddressFromCaip(caipAccount)

  try {
    console.log('[Aztec] Fetching private balance...')

    const result = await simulateAzguardView(
      client,
      caipAccount,
      TOKENS.aztec.address,
      AZTEC_TOKEN_METHODS.balance_of_private,
      [userAddress]
    )

    return BigInt(result?.toString() || '0')
  } catch (e) {
    console.error('[Aztec] Failed to fetch private balance:', e)
    return null
  }
}

/**
 * Get public USDC balance on Aztec
 */
export async function getAztecPublicBalance(
  client: AzguardClient,
  caipAccount: string
): Promise<bigint | null> {
  if (!TOKENS.aztec.address) {
    throw new Error('Token address not configured')
  }

  const userAddress = extractAddressFromCaip(caipAccount)

  try {
    const result = await simulateAzguardView(
      client,
      caipAccount,
      TOKENS.aztec.address,
      AZTEC_TOKEN_METHODS.balance_of_public,
      [userAddress]
    )

    return BigInt(result?.toString() || '0')
  } catch (e) {
    console.error('[Aztec] Failed to fetch public balance:', e)
    return null
  }
}
