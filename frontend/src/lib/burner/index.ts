/**
 * Burner Address Derivation (Two-Layer)
 *
 * Layer 1: Master key - derived from a fixed message, re-derivable anytime
 * Layer 2: Burner key - derived from master key + timestamp nonce
 *
 * Recovery (if localStorage is lost):
 * 1. Re-sign master message → get master key
 * 2. Brute-force nonce locally (no MetaMask popups): try timestamps in range
 * 3. Find the nonce that produces the lost burner address
 */

import { keccak256, type Hex, type WalletClient, encodePacked } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Version for the derivation scheme - bump if changing the algorithm
const DERIVATION_VERSION = 'v2';

// Domain separator for zkzkp2p
const DOMAIN = 'zkzkp2p';

// ============================================================================
// Master Key (Layer 1) - Re-derivable anytime
// ============================================================================

/**
 * Get the master key derivation message (fixed per wallet)
 */
export function getMasterKeyMessage(mainAddress: Hex): string {
  return [
    `${DOMAIN} master key ${DERIVATION_VERSION}`,
    `Address: ${mainAddress}`,
    '',
    'Sign this message to derive your zkzkp2p master key.',
    'This allows recovery of burner wallets if needed.',
  ].join('\n');
}

/**
 * Derive the master key from a MetaMask signature
 */
export function deriveMasterKey(signature: Hex): Hex {
  return keccak256(encodePacked(['string', 'bytes'], [DOMAIN + '-master', signature]));
}

/**
 * Get or derive the master key (caches in memory for session)
 */
let cachedMasterKey: { address: Hex; key: Hex } | null = null;

export async function getMasterKey(
  walletClient: WalletClient,
  mainAddress: Hex
): Promise<Hex> {
  // Return cached if same address
  if (cachedMasterKey && cachedMasterKey.address.toLowerCase() === mainAddress.toLowerCase()) {
    return cachedMasterKey.key;
  }

  // Request signature
  const message = getMasterKeyMessage(mainAddress);
  const signature = await walletClient.signMessage({
    account: mainAddress,
    message,
  });

  const masterKey = deriveMasterKey(signature as Hex);

  // Cache for session
  cachedMasterKey = { address: mainAddress, key: masterKey };

  return masterKey;
}

/**
 * Clear cached master key (call on disconnect)
 */
export function clearMasterKeyCache(): void {
  cachedMasterKey = null;
}

// ============================================================================
// Burner Key (Layer 2) - Derived from master + nonce
// ============================================================================

/**
 * Generate a timestamp-based nonce (minute precision)
 * This allows brute-forcing ~43k attempts per month if lost
 */
export function generateNonce(): number {
  return Math.floor(Date.now() / 60000); // Minutes since epoch
}

/**
 * Derive a burner private key from master key + nonce
 */
export function deriveBurnerKeyFromMaster(masterKey: Hex, nonce: number): Hex {
  // Use encodePacked for proper type handling (masterKey is bytes32, nonce as uint64)
  return keccak256(encodePacked(['bytes32', 'uint64'], [masterKey, BigInt(nonce)]));
}

/**
 * Get the EOA address for a private key
 */
export function getAddressFromPrivateKey(privateKey: Hex): Hex {
  return privateKeyToAccount(privateKey).address;
}

// ============================================================================
// Main Derivation Function
// ============================================================================

/**
 * Derive a fresh burner for a new deposit
 *
 * 1. Gets/derives master key (may prompt MetaMask if not cached)
 * 2. Generates timestamp nonce
 * 3. Derives burner key from master + nonce
 */
export async function deriveBurner(
  walletClient: WalletClient,
  mainAddress: Hex,
  existingNonce?: number // Pass existing nonce for recovery
): Promise<{
  privateKey: Hex;
  eoaAddress: Hex;
  nonce: number;
}> {
  // Get master key (cached or prompt for signature)
  const masterKey = await getMasterKey(walletClient, mainAddress);

  // Use existing nonce (recovery) or generate new one
  const nonce = existingNonce ?? generateNonce();

  // Derive burner key
  const privateKey = deriveBurnerKeyFromMaster(masterKey, nonce);
  const eoaAddress = getAddressFromPrivateKey(privateKey);

  return {
    privateKey,
    eoaAddress,
    nonce,
  };
}

/**
 * Recover a burner by re-deriving with known nonce
 */
export async function recoverBurner(
  walletClient: WalletClient,
  mainAddress: Hex,
  nonce: number
): Promise<{
  privateKey: Hex;
  eoaAddress: Hex;
}> {
  const { privateKey, eoaAddress } = await deriveBurner(walletClient, mainAddress, nonce);
  return { privateKey, eoaAddress };
}

// ============================================================================
// Emergency Recovery (brute-force nonce)
// ============================================================================

/**
 * Brute-force find the nonce that produces a given burner address
 * Used when localStorage is lost but you know the burner address
 *
 * @param masterKey - The master key (re-derived from signature)
 * @param targetAddress - The burner address to find
 * @param daysBack - How many days back to search (default 30)
 * @returns The nonce if found, null otherwise
 */
export function bruteForceNonce(
  masterKey: Hex,
  targetAddress: Hex,
  daysBack: number = 30
): number | null {
  const now = Math.floor(Date.now() / 60000);
  const minutesBack = daysBack * 24 * 60;
  const targetLower = targetAddress.toLowerCase();

  console.log(`[Recovery] Brute-forcing nonce for ${targetAddress}...`);
  console.log(`[Recovery] Searching ${minutesBack} nonces (${daysBack} days back)`);

  for (let i = 0; i <= minutesBack; i++) {
    const nonce = now - i;
    const privateKey = deriveBurnerKeyFromMaster(masterKey, nonce);
    const address = getAddressFromPrivateKey(privateKey);

    if (address.toLowerCase() === targetLower) {
      console.log(`[Recovery] Found! Nonce: ${nonce}`);
      return nonce;
    }

    // Progress log every 10000 iterations
    if (i > 0 && i % 10000 === 0) {
      console.log(`[Recovery] Checked ${i} nonces...`);
    }
  }

  console.log(`[Recovery] Nonce not found in range`);
  return null;
}

/**
 * Full emergency recovery flow
 *
 * 1. Prompts for master key signature
 * 2. Brute-forces to find the nonce
 * 3. Returns the recovered burner key
 */
export async function emergencyRecoverBurner(
  walletClient: WalletClient,
  mainAddress: Hex,
  targetBurnerAddress: Hex,
  daysBack: number = 30
): Promise<{
  privateKey: Hex;
  eoaAddress: Hex;
  nonce: number;
} | null> {
  // Get master key
  const masterKey = await getMasterKey(walletClient, mainAddress);

  // Brute-force find the nonce
  const nonce = bruteForceNonce(masterKey, targetBurnerAddress, daysBack);

  if (nonce === null) {
    return null;
  }

  // Re-derive the burner key
  const privateKey = deriveBurnerKeyFromMaster(masterKey, nonce);
  const eoaAddress = getAddressFromPrivateKey(privateKey);

  return {
    privateKey,
    eoaAddress,
    nonce,
  };
}

// ============================================================================
// Deprecated: Index-based functions (keeping for reference)
// ============================================================================

/** @deprecated Use generateNonce() instead */
export function getNextDepositIndex(_address: Hex): number {
  return generateNonce();
}

/** @deprecated No longer needed with timestamp nonces */
export function incrementDepositIndex(_address: Hex): number {
  return generateNonce();
}
