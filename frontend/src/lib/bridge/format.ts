/**
 * Shared token amount formatting helpers (USDC defaults to 6 decimals)
 */

/**
 * Format token amount for display
 */
export function formatTokenAmount(amount: bigint, decimals: number = 6): string {
  const divisor = BigInt(10 ** decimals)
  const whole = amount / divisor
  const fraction = amount % divisor
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 2)
  return `${whole}.${fractionStr}`
}

/**
 * Parse token amount from string
 */
export function parseTokenAmount(amount: string, decimals: number = 6): bigint {
  const [whole, fraction = ''] = amount.split('.')
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals)
  return BigInt(whole || '0') * BigInt(10 ** decimals) + BigInt(paddedFraction)
}
