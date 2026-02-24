/**
 * Balance Query Functions
 * Query EVM and Aztec token balances
 */

import type { PublicClient } from 'viem'
import { TOKENS } from './config'

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
 * Get private USDC balance on Aztec via embedded wallet's PXE
 */
export async function getAztecPrivateBalance(
  aztecWallet: any, // EmbeddedWallet (Wallet interface)
  aztecAddress: string
): Promise<bigint | null> {
  if (!TOKENS.aztec.address) {
    console.error('[Aztec] AZTEC_TOKEN_ADDRESS not configured!')
    throw new Error('Token address not configured')
  }

  try {
    console.log('[Aztec] Fetching private balance...')

    // Use the wallet's PXE to simulate an unconstrained call
    const pxe = aztecWallet.getNode ? aztecWallet.getNode() : aztecWallet.pxe;
    if (!pxe) {
      console.error('[Aztec] Cannot access PXE from wallet');
      return null;
    }

    // Import AztecAddress for proper type handling
    const { AztecAddress } = await import('@aztec/aztec.js/addresses');
    const tokenAddr = AztecAddress.fromString(TOKENS.aztec.address);
    const userAddr = AztecAddress.fromString(aztecAddress);

    // Use simulateUnconstrained to call balance_of_private
    const result = await pxe.simulateUnconstrained(
      'balance_of_private',
      [userAddr],
      tokenAddr,
      userAddr
    );

    return BigInt(result?.toString() || '0');
  } catch (e) {
    console.error('[Aztec] Failed to fetch private balance:', e);
    return null;
  }
}

/**
 * Get public USDC balance on Aztec via embedded wallet's PXE
 */
export async function getAztecPublicBalance(
  aztecWallet: any, // EmbeddedWallet (Wallet interface)
  aztecAddress: string
): Promise<bigint | null> {
  if (!TOKENS.aztec.address) {
    throw new Error('Token address not configured')
  }

  try {
    const pxe = aztecWallet.getNode ? aztecWallet.getNode() : aztecWallet.pxe;
    if (!pxe) {
      console.error('[Aztec] Cannot access PXE from wallet');
      return null;
    }

    const { AztecAddress } = await import('@aztec/aztec.js/addresses');
    const tokenAddr = AztecAddress.fromString(TOKENS.aztec.address);
    const userAddr = AztecAddress.fromString(aztecAddress);

    const result = await pxe.simulateUnconstrained(
      'balance_of_public',
      [userAddr],
      tokenAddr,
      userAddr
    );

    return BigInt(result?.toString() || '0');
  } catch (e) {
    console.error('[Aztec] Failed to fetch public balance:', e);
    return null;
  }
}
