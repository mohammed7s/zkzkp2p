/**
 * Crypto utilities for HTLC secret/hashlock generation
 * Browser-compatible port of train-contracts/chains/aztec/scripts/utils.ts
 */

/**
 * Convert a Uint8Array to a bigint
 */
function uint8ArrayToBigInt(uint8Array: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < uint8Array.length; i++) {
    result = (result << 8n) | BigInt(uint8Array[i]);
  }
  return result;
}

/**
 * Convert a bigint to a Uint8Array of specified length
 */
function bigIntToUint8Array(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

/**
 * Generate random bytes using Web Crypto API
 */
function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof window !== 'undefined' && window.crypto) {
    window.crypto.getRandomValues(bytes);
  } else if (typeof globalThis !== 'undefined' && (globalThis as any).crypto) {
    (globalThis as any).crypto.getRandomValues(bytes);
  } else {
    // Fallback for Node.js environment
    throw new Error('No crypto API available');
  }
  return bytes;
}

/**
 * SHA-256 hash using Web Crypto API
 */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Create a new ArrayBuffer copy to avoid SharedArrayBuffer type issues
  const buffer = new ArrayBuffer(data.length);
  new Uint8Array(buffer).set(data);

  if (typeof window !== 'undefined' && window.crypto?.subtle) {
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
    return new Uint8Array(hashBuffer);
  } else if (typeof globalThis !== 'undefined' && (globalThis as any).crypto?.subtle) {
    const hashBuffer = await (globalThis as any).crypto.subtle.digest('SHA-256', buffer);
    return new Uint8Array(hashBuffer);
  }
  throw new Error('No crypto.subtle API available');
}

/**
 * Secret and hashlock tuple type
 * [secretHigh, secretLow, hashlockHigh, hashlockLow] - all u128 bigints
 */
export type SecretHashlock = {
  secretHigh: bigint;
  secretLow: bigint;
  hashlockHigh: bigint;
  hashlockLow: bigint;
  // Full values for EVM compatibility
  secretBytes: Uint8Array;
  hashlockBytes: Uint8Array;
};

/**
 * Generates a secret and its SHA-256 hash lock, split into high and low halves.
 * @returns A tuple with [secretHigh, secretLow, hashlockHigh, hashlockLow] as u128 bigint numbers.
 */
export async function generateSecretAndHashlock(): Promise<SecretHashlock> {
  const secretBytes = getRandomBytes(32);
  const hashlockBytes = await sha256(secretBytes);

  const secretHigh = uint8ArrayToBigInt(secretBytes.slice(0, 16));
  const secretLow = uint8ArrayToBigInt(secretBytes.slice(16, 32));

  const hashlockHigh = uint8ArrayToBigInt(hashlockBytes.slice(0, 16));
  const hashlockLow = uint8ArrayToBigInt(hashlockBytes.slice(16, 32));

  return {
    secretHigh,
    secretLow,
    hashlockHigh,
    hashlockLow,
    secretBytes,
    hashlockBytes,
  };
}

/**
 * Generates a unique identifier using random bytes.
 * @returns A bigint identifier (31 bytes, fits in Fr field).
 */
export function generateSwapId(): bigint {
  const bytes = getRandomBytes(31);
  return uint8ArrayToBigInt(bytes);
}

/**
 * Convert hashlock (high, low) to bytes32 for EVM contracts
 */
export function hashlockToBytes32(high: bigint, low: bigint): `0x${string}` {
  const highBytes = bigIntToUint8Array(high, 16);
  const lowBytes = bigIntToUint8Array(low, 16);
  const combined = new Uint8Array(32);
  combined.set(highBytes, 0);
  combined.set(lowBytes, 16);
  return ('0x' + Array.from(combined).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

/**
 * Convert secret (high, low) to uint256 for EVM redemption
 */
export function secretToUint256(high: bigint, low: bigint): bigint {
  return (high << 128n) | low;
}

/**
 * Convert swap ID to bytes32 for EVM contracts
 */
export function swapIdToBytes32(swapId: bigint): `0x${string}` {
  const bytes = bigIntToUint8Array(swapId, 32);
  return ('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

/**
 * Convert bytes32 string to bigint
 */
export function bytes32ToBigInt(bytes32: `0x${string}`): bigint {
  return BigInt(bytes32);
}

/**
 * Pad string to specified length (for Aztec contract string params)
 */
export function padString(str: string, length: number): string {
  return str.padStart(length, ' ');
}

/**
 * Calculate timelock timestamp (current + seconds)
 */
export function calculateTimelock(secondsFromNow: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + secondsFromNow);
}
