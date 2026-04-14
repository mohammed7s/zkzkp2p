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
 * Call an unconstrained (view) function on the Token contract.
 * Tries multiple approaches since the SDK API varies across versions.
 */
async function callUnconstrained(
  aztecWallet: any,
  methodName: string,
  userAddr: any,
  tokenAddr: any,
): Promise<bigint> {
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  const token = await TokenContract.at(tokenAddr, aztecWallet);

  const fn = (token.methods as any)[methodName](userAddr);

  // .simulate() takes an options object { from }, not a positional address.
  // `from` sets the scope for note discovery (whose notes to decrypt).
  const raw = await fn.simulate({ from: userAddr });
  // 4.2 returns {result: "value", offchainEffects: [], ...} instead of a direct value
  const result = raw?.result !== undefined ? raw.result : raw;
  return BigInt(result?.toString() || '0');
}

/**
 * Get private USDC balance on Aztec
 */
export async function getAztecPrivateBalance(
  aztecWallet: any,
  aztecAddress: string
): Promise<bigint | null> {
  if (!TOKENS.aztec.address) {
    throw new Error('Token address not configured')
  }

  try {
    const { AztecAddress } = await import('@aztec/aztec.js/addresses');
    const tokenAddr = AztecAddress.fromString(TOKENS.aztec.address);
    const userAddr = AztecAddress.fromString(aztecAddress);
    return await callUnconstrained(aztecWallet, 'balance_of_private', userAddr, tokenAddr);
  } catch (e) {
    console.error('[Aztec] Failed to fetch private balance:', e);
    return null;
  }
}

/**
 * Get public USDC balance on Aztec
 */
export async function getAztecPublicBalance(
  aztecWallet: any,
  aztecAddress: string
): Promise<bigint | null> {
  if (!TOKENS.aztec.address) {
    throw new Error('Token address not configured')
  }

  try {
    const { AztecAddress } = await import('@aztec/aztec.js/addresses');
    const tokenAddr = AztecAddress.fromString(TOKENS.aztec.address);
    const userAddr = AztecAddress.fromString(aztecAddress);
    return await callUnconstrained(aztecWallet, 'balance_of_public', userAddr, tokenAddr);
  } catch (e) {
    console.error('[Aztec] Failed to fetch public balance:', e);
    return null;
  }
}
