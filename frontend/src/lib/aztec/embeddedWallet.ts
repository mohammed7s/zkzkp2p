/**
 * Embedded Aztec Wallet via @aztec/wallets
 *
 * Uses EmbeddedWallet which runs a local PXE in the browser.
 * Keys are derived from a MetaMask personal_sign signature, so
 * the user only needs MetaMask — no separate Aztec wallet extension.
 */

import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { BarretenbergSync } from '@aztec/bb.js';
import { Fr } from '@aztec/aztec.js/fields';
import { keccak256, encodePacked, type Hex } from 'viem';
import { CHAINS } from '@/config';

// Domain separator
const DOMAIN = 'zkzkp2p-aztec';

// Cached wallet instance
let cachedWallet: {
  address: string;
  wallet: EmbeddedWallet;
} | null = null;

/**
 * Get the message to sign for Aztec key derivation
 */
export function getAztecDerivationMessage(mainAddress: string): string {
  return [
    'zkzkp2p aztec wallet v1',
    `Address: ${mainAddress}`,
    '',
    'Sign to derive your Aztec wallet keys.',
  ].join('\n');
}

/**
 * Derive the Aztec secret from a MetaMask signature
 * Returns an Fr field element suitable for account creation
 */
export function deriveAztecSecret(signature: Hex): Fr {
  const hash = keccak256(encodePacked(['string', 'bytes'], [DOMAIN, signature]));
  // keccak256 output can exceed BN254 field modulus, so reduce
  return Fr.fromBufferReduce(Buffer.from(hash.slice(2), 'hex'));
}

/**
 * Derive a salt from the user's EVM address (deterministic)
 */
export function deriveSalt(address: string): Fr {
  const hash = keccak256(encodePacked(['string', 'address'], [DOMAIN + '-salt', address as Hex]));
  return Fr.fromBufferReduce(Buffer.from(hash.slice(2), 'hex'));
}

/**
 * Derive a signing key buffer from the secret (for ECDSA K accounts)
 */
export function deriveSigningKey(secret: Fr): Buffer {
  // Use the secret bytes directly as the 32-byte signing key
  const hex = secret.toString();
  return Buffer.from(hex.replace('0x', ''), 'hex');
}

/**
 * Connect to Aztec using MetaMask-derived keys via EmbeddedWallet.
 *
 * Flow:
 * 1. MetaMask personal_sign → signature
 * 2. keccak256(encodePacked("zkzkp2p-aztec", signature)) → Fr secret
 * 3. EmbeddedWallet.create(nodeUrl) → embedded wallet with local PXE
 * 4. wallet.createECDSAKAccount(secret, salt, signingKey) → Aztec account
 * 5. Return the wallet (implements Wallet interface)
 */
export async function connectEmbeddedWallet(
  signMessage: (message: string) => Promise<Hex>,
  mainAddress: string
): Promise<{
  wallet: EmbeddedWallet;
  address: string;
}> {
  // Return cached wallet if same address
  if (cachedWallet && cachedWallet.address.toLowerCase() === mainAddress.toLowerCase()) {
    return {
      wallet: cachedWallet.wallet,
      address: cachedWallet.address,
    };
  }

  // Step 1: Get signature from MetaMask
  console.log('[EmbeddedWallet] Step 1: Requesting MetaMask signature...');
  const message = getAztecDerivationMessage(mainAddress);
  const signature = await signMessage(message);
  console.log('[EmbeddedWallet] Step 1 complete: Got signature');

  // Step 2: Derive secret, salt, and signing key
  console.log('[EmbeddedWallet] Step 2: Deriving keys...');
  const secret = deriveAztecSecret(signature);
  const salt = deriveSalt(mainAddress);
  const signingKey = deriveSigningKey(secret);
  console.log('[EmbeddedWallet] Step 2 complete: Keys derived');

  // Step 3: Create EmbeddedWallet (starts local PXE)
  const nodeUrl = CHAINS.aztec.nodeUrl;
  console.log('[EmbeddedWallet] Step 3: Creating EmbeddedWallet with node:', nodeUrl);
  console.log('[EmbeddedWallet] Environment check:', {
    crossOriginIsolated: typeof self !== 'undefined' ? (self as any).crossOriginIsolated : 'N/A',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 'N/A',
  });
  console.log('[EmbeddedWallet] This may take a while (PXE init + WASM setup)...');

  // Pre-initialize BarretenbergSync with logging so we can see what bb.js is doing.
  // Since it's a singleton, later calls from PXE will reuse this instance.
  console.log('[EmbeddedWallet] Pre-initializing BarretenbergSync...');
  try {
    await BarretenbergSync.initSingleton({
      logger: (msg: string) => console.log('[bb.js]', msg),
    });
    console.log('[EmbeddedWallet] BarretenbergSync initialized successfully');
  } catch (e: any) {
    console.error('[EmbeddedWallet] BarretenbergSync init FAILED:', e);
    console.error('[EmbeddedWallet] This is the WASM crash. See bb.js logs above for details.');
    throw new Error(`bb.js WASM initialization failed: ${e.message || 'proc_exit called'}`);
  }

  const t0 = Date.now();
  const wallet = await EmbeddedWallet.create(nodeUrl);
  console.log('[EmbeddedWallet] Step 3 complete: Wallet created in', Date.now() - t0, 'ms');

  // Step 4: Create ECDSA K account
  console.log('[EmbeddedWallet] Step 4: Creating ECDSA K account...');
  const t1 = Date.now();
  const account = await wallet.createECDSAKAccount(secret, salt, signingKey);
  console.log('[EmbeddedWallet] Step 4 complete: Account created in', Date.now() - t1, 'ms');

  // Get the account address (AccountManager exposes .address, not .getAddress())
  const aztecAddress = account.address.toString();
  console.log('[EmbeddedWallet] Done! Account address:', aztecAddress);

  // Cache the wallet
  cachedWallet = {
    address: mainAddress.toLowerCase(),
    wallet,
  };

  return {
    wallet,
    address: aztecAddress,
  };
}

/**
 * Disconnect and clean up the embedded wallet
 */
export async function disconnectEmbeddedWallet(): Promise<void> {
  if (cachedWallet) {
    try {
      await cachedWallet.wallet.stop();
    } catch (e) {
      console.error('[EmbeddedWallet] Error stopping wallet:', e);
    }
    cachedWallet = null;
  }
}

/**
 * Get the cached wallet instance (if connected)
 */
export function getCachedWallet(): EmbeddedWallet | null {
  return cachedWallet?.wallet ?? null;
}

/**
 * Shorten address for display
 */
export function shortenAddress(address: string, chars = 4): string {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}
