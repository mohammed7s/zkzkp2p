/**
 * Embedded Aztec Wallet via @aztec/wallets
 *
 * Uses BrowserEmbeddedWallet which runs a local PXE in the browser.
 * Keys are derived from a MetaMask personal_sign signature, so
 * the user only needs MetaMask — no separate Aztec wallet extension.
 */

import { BrowserEmbeddedWallet } from '@aztec/wallets/embedded';
import { Fr } from '@aztec/aztec.js/fields';
import { keccak256, encodePacked, type Hex } from 'viem';
import { CHAINS } from '@/config';

// Domain separator
const DOMAIN = 'zkzkp2p-aztec';

// Cached wallet instance
let cachedWallet: {
  address: string;
  wallet: BrowserEmbeddedWallet;
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
  return Fr.fromString(hash);
}

/**
 * Derive a salt from the user's EVM address (deterministic)
 */
export function deriveSalt(address: string): Fr {
  const hash = keccak256(encodePacked(['string', 'address'], [DOMAIN + '-salt', address as Hex]));
  return Fr.fromString(hash);
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
 * Connect to Aztec using MetaMask-derived keys via BrowserEmbeddedWallet.
 *
 * Flow:
 * 1. MetaMask personal_sign → signature
 * 2. keccak256(encodePacked("zkzkp2p-aztec", signature)) → Fr secret
 * 3. BrowserEmbeddedWallet.create(nodeUrl) → embedded wallet with local PXE
 * 4. wallet.createECDSAKAccount(secret, salt, signingKey) → Aztec account
 * 5. Return the wallet (implements Wallet interface)
 */
export async function connectEmbeddedWallet(
  signMessage: (message: string) => Promise<Hex>,
  mainAddress: string
): Promise<{
  wallet: BrowserEmbeddedWallet;
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
  const message = getAztecDerivationMessage(mainAddress);
  const signature = await signMessage(message);

  // Step 2: Derive secret, salt, and signing key
  const secret = deriveAztecSecret(signature);
  const salt = deriveSalt(mainAddress);
  const signingKey = deriveSigningKey(secret);

  // Step 3: Create BrowserEmbeddedWallet (starts local PXE)
  const nodeUrl = CHAINS.aztec.nodeUrl;
  console.log('[EmbeddedWallet] Creating wallet with node:', nodeUrl);
  const wallet = await BrowserEmbeddedWallet.create(nodeUrl);

  // Step 4: Create ECDSA K account
  console.log('[EmbeddedWallet] Creating ECDSA K account...');
  const account = await wallet.createECDSAKAccount(secret, salt, signingKey);

  // Get the account address
  const aztecAddress = account.getAddress().toString();
  console.log('[EmbeddedWallet] Account address:', aztecAddress);

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
export function getCachedWallet(): BrowserEmbeddedWallet | null {
  return cachedWallet?.wallet ?? null;
}

/**
 * Shorten address for display
 */
export function shortenAddress(address: string, chars = 4): string {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}
