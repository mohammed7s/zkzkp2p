/**
 * Burner Address Derivation (Two-Layer, Sequential Index)
 *
 * Layer 1: Master key - derived from a MetaMask signature, re-derivable anytime
 * Layer 2: Burner key - derived from master key + sequential index (0, 1, 2, ...)
 *
 * Recovery (if localStorage is lost):
 * 1. Re-sign master message → get master key
 * 2. Scan burner_0, burner_1, ... checking USDC balance on each
 * 3. Any funded burner is a pending flow to recover
 * 4. Next unused index = first with zero balance after N consecutive empties
 */

import { keccak256, type Hex, type WalletClient, type PublicClient, encodePacked, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Version for the derivation scheme - bump if changing the algorithm
const DERIVATION_VERSION = 'v3';

// Domain separator for zkzkp2p
const DOMAIN = 'zkzkp2p';

// How many consecutive empty burners before we stop scanning
const SCAN_EMPTY_THRESHOLD = 3;

// localStorage key for persisting the next burner index
const INDEX_STORAGE_KEY = 'zkzkp2p-burner-next-index';

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
  return keccak256(encodePacked(['string', 'bytes'], [DOMAIN + '-master-' + DERIVATION_VERSION, signature]));
}

/**
 * Get or derive the master key (caches in memory for session)
 */
let cachedMasterKey: { address: Hex; key: Hex } | null = null;

export async function getMasterKey(
  walletClient: WalletClient,
  mainAddress: Hex
): Promise<Hex> {
  if (cachedMasterKey && cachedMasterKey.address.toLowerCase() === mainAddress.toLowerCase()) {
    return cachedMasterKey.key;
  }

  const message = getMasterKeyMessage(mainAddress);
  const signature = await walletClient.signMessage({
    account: mainAddress,
    message,
  });

  const masterKey = deriveMasterKey(signature as Hex);
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
// Burner Key (Layer 2) - Sequential index derivation
// ============================================================================

/**
 * Derive a burner private key from master key + index
 */
export function deriveBurnerKey(masterKey: Hex, index: number): Hex {
  return keccak256(encodePacked(['bytes32', 'uint64'], [masterKey, BigInt(index)]));
}

/**
 * Get the EOA address for a private key
 */
export function getAddressFromPrivateKey(privateKey: Hex): Hex {
  return privateKeyToAccount(privateKey).address;
}

// ============================================================================
// Index Management (localStorage)
// ============================================================================

function getStorageKey(mainAddress: Hex): string {
  return `${INDEX_STORAGE_KEY}:${mainAddress.toLowerCase()}`;
}

/**
 * Get the next burner index from localStorage
 */
export function getNextIndex(mainAddress: Hex): number {
  try {
    const stored = localStorage.getItem(getStorageKey(mainAddress));
    return stored ? parseInt(stored, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Save the next burner index to localStorage
 */
export function setNextIndex(mainAddress: Hex, index: number): void {
  try {
    localStorage.setItem(getStorageKey(mainAddress), String(index));
  } catch {}
}

// ============================================================================
// Scanning - Find funded burners on-chain
// ============================================================================

export interface FundedBurner {
  index: number;
  privateKey: Hex;
  eoaAddress: Hex;
  smartAccountAddress: Hex;
  balance: bigint;
}

/**
 * Scan burner addresses for USDC balance.
 * Returns all funded burners and the next free index.
 */
export async function scanBurners(
  masterKey: Hex,
  publicClient: PublicClient,
  tokenAddress: Hex,
  getSmartAccountAddress: (privateKey: Hex) => Promise<Hex>,
  opts?: { maxIndex?: number; onProgress?: (index: number) => void }
): Promise<{
  fundedBurners: FundedBurner[];
  nextFreeIndex: number;
}> {
  const maxIndex = opts?.maxIndex ?? 50;
  const fundedBurners: FundedBurner[] = [];
  let consecutiveEmpty = 0;
  let nextFreeIndex = 0;

  for (let i = 0; i < maxIndex; i++) {
    opts?.onProgress?.(i);

    const privateKey = deriveBurnerKey(masterKey, i);
    const eoaAddress = getAddressFromPrivateKey(privateKey);

    let smartAccountAddress: Hex;
    try {
      smartAccountAddress = await getSmartAccountAddress(privateKey);
    } catch {
      // If smart account derivation fails, skip
      consecutiveEmpty++;
      if (consecutiveEmpty >= SCAN_EMPTY_THRESHOLD) {
        nextFreeIndex = i - SCAN_EMPTY_THRESHOLD + 1;
        // But nextFreeIndex should be after any funded one
        break;
      }
      continue;
    }

    // Check USDC balance on smart account
    let balance = 0n;
    try {
      balance = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [smartAccountAddress],
      });
    } catch {}

    if (balance > 0n) {
      fundedBurners.push({
        index: i,
        privateKey,
        eoaAddress,
        smartAccountAddress,
        balance,
      });
      consecutiveEmpty = 0;
    } else {
      consecutiveEmpty++;
      if (consecutiveEmpty >= SCAN_EMPTY_THRESHOLD && i > 0) {
        break;
      }
    }
  }

  // Next free index: max of (stored index, highest funded + 1, first gap after consecutive empties)
  const highestFunded = fundedBurners.length > 0
    ? Math.max(...fundedBurners.map(b => b.index)) + 1
    : 0;
  nextFreeIndex = Math.max(nextFreeIndex, highestFunded);

  return { fundedBurners, nextFreeIndex };
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Derive a fresh burner for a new deposit.
 * Uses the next sequential index, increments it in localStorage.
 */
export async function deriveBurner(
  walletClient: WalletClient,
  mainAddress: Hex,
  existingIndex?: number
): Promise<{
  privateKey: Hex;
  eoaAddress: Hex;
  index: number;
}> {
  const masterKey = await getMasterKey(walletClient, mainAddress);

  const index = existingIndex ?? getNextIndex(mainAddress);

  const privateKey = deriveBurnerKey(masterKey, index);
  const eoaAddress = getAddressFromPrivateKey(privateKey);

  // Only increment if we're using a new index (not recovering)
  if (existingIndex === undefined) {
    setNextIndex(mainAddress, index + 1);
  }

  return { privateKey, eoaAddress, index };
}

/**
 * Recover a burner by index
 */
export async function recoverBurner(
  walletClient: WalletClient,
  mainAddress: Hex,
  index: number
): Promise<{
  privateKey: Hex;
  eoaAddress: Hex;
}> {
  const { privateKey, eoaAddress } = await deriveBurner(walletClient, mainAddress, index);
  return { privateKey, eoaAddress };
}

/**
 * Scan and recover all funded burners.
 * Call on page load / wallet connect to find pending flows.
 */
export async function scanAndRecover(
  walletClient: WalletClient,
  mainAddress: Hex,
  publicClient: PublicClient,
  tokenAddress: Hex,
  getSmartAccountAddress: (privateKey: Hex) => Promise<Hex>,
  onProgress?: (index: number) => void
): Promise<{
  fundedBurners: FundedBurner[];
  nextFreeIndex: number;
}> {
  const masterKey = await getMasterKey(walletClient, mainAddress);

  const result = await scanBurners(
    masterKey,
    publicClient,
    tokenAddress,
    getSmartAccountAddress,
    { onProgress }
  );

  // Update stored index to at least the next free one
  const currentStored = getNextIndex(mainAddress);
  if (result.nextFreeIndex > currentStored) {
    setNextIndex(mainAddress, result.nextFreeIndex);
  }

  return result;
}

// ============================================================================
// Deprecated: Keep old exports for backward compat during migration
// ============================================================================

/** @deprecated Use index-based derivation */
export function generateNonce(): number {
  return Math.floor(Date.now() / 60000);
}

/** @deprecated Use getNextIndex() */
export function getNextDepositIndex(_address: Hex): number {
  return 0;
}

/** @deprecated No longer needed */
export function incrementDepositIndex(_address: Hex): number {
  return 0;
}

/** @deprecated Use scanAndRecover instead */
export function bruteForceNonce(): null {
  return null;
}

/** @deprecated Use scanAndRecover instead */
export async function emergencyRecoverBurner(): Promise<null> {
  return null;
}
