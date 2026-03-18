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

// SessionStorage key for cached derived keys
const SESSION_KEY = 'zkzkp2p-aztec-keys';

// Cached wallet instance
let cachedWallet: {
  address: string;
  wallet: EmbeddedWallet;
} | null = null;

/**
 * Cache derived keys in sessionStorage so we can auto-reconnect on page reload
 * without requiring another MetaMask signature popup.
 * Uses sessionStorage (not localStorage) so keys are cleared when the tab closes.
 */
function cacheKeys(mainAddress: string, secret: string, salt: string, signingKey: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      address: mainAddress.toLowerCase(),
      secret,
      salt,
      signingKey,
    }));
  } catch (e) {
    console.warn('[EmbeddedWallet] Failed to cache keys:', e);
  }
}

/**
 * Retrieve cached keys from sessionStorage
 */
function getCachedKeys(mainAddress: string): { secret: string; salt: string; signingKey: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.address !== mainAddress.toLowerCase()) return null;
    return { secret: data.secret, salt: data.salt, signingKey: data.signingKey };
  } catch {
    return null;
  }
}

/**
 * Clear cached keys (on disconnect)
 */
function clearCachedKeys(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
}

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
  // ECDSA-K expects a 32-byte secp256k1 private key. `Fr.toString()` omits
  // leading zeroes, so pad explicitly to keep the numeric key stable.
  const hex = secret.toString().replace('0x', '').padStart(64, '0').slice(-64);
  return Buffer.from(hex, 'hex');
}

function getKnownSenders(ownAztecAddress: string): string[] {
  const configured = String(import.meta.env.NEXT_PUBLIC_AZTEC_SENDER_ADDRESSES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const solver = String(import.meta.env.NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS || '').trim();

  // Include self explicitly so self-sends are always discoverable even on fresh stores.
  const candidates = [...configured, solver, ownAztecAddress];
  return Array.from(new Set(candidates.map(a => a.toLowerCase())));
}

async function registerKnownSenders(wallet: EmbeddedWallet, ownAztecAddress: string): Promise<void> {
  const senders = getKnownSenders(ownAztecAddress);
  const own = ownAztecAddress.toLowerCase();
  if (senders.length === 0) return;

  try {
    const { AztecAddress } = await import('@aztec/aztec.js/addresses');
    for (const sender of senders) {
      try {
        await wallet.registerSender(AztecAddress.fromString(sender), sender === own ? 'self' : 'known');
      } catch (e: any) {
        console.warn('[EmbeddedWallet] Failed to register sender:', sender, e?.message || e);
      }
    }

    if (typeof (wallet as any).getAddressBook === 'function') {
      const addressBook = await (wallet as any).getAddressBook();
      console.log('[EmbeddedWallet] Sender address book size:', addressBook?.length ?? 0);
    }
  } catch (e: any) {
    console.warn('[EmbeddedWallet] Sender registration setup failed:', e?.message || e);
  }
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

  // Cache keys in sessionStorage for auto-reconnect on reload
  cacheKeys(mainAddress, secret.toString(), salt.toString(), signingKey.toString('hex'));

  // Steps 3-4: Create wallet and account
  return await createWalletWithKeys(mainAddress, secret, salt, signingKey);
}

/**
 * Reconnect to Aztec using cached keys from sessionStorage.
 * No MetaMask popup — keys were cached during the initial derivation.
 * Returns null if no cached keys exist for this address.
 */
export async function reconnectEmbeddedWallet(
  mainAddress: string
): Promise<{ wallet: EmbeddedWallet; address: string } | null> {
  // Return in-memory cached wallet if same address
  if (cachedWallet && cachedWallet.address.toLowerCase() === mainAddress.toLowerCase()) {
    return {
      wallet: cachedWallet.wallet,
      address: cachedWallet.address,
    };
  }

  // Check sessionStorage for cached keys
  const keys = getCachedKeys(mainAddress);
  if (!keys) {
    console.log('[EmbeddedWallet] No cached keys for', mainAddress);
    return null;
  }

  console.log('[EmbeddedWallet] Auto-reconnecting with cached keys...');
  const secret = Fr.fromString(keys.secret);
  const salt = Fr.fromString(keys.salt);
  const signingKey = Buffer.from(keys.signingKey, 'hex');

  return await createWalletWithKeys(mainAddress, secret, salt, signingKey);
}

/**
 * Check if we have cached keys for auto-reconnect (synchronous, no WASM)
 */
export function hasCachedKeys(mainAddress: string): boolean {
  return getCachedKeys(mainAddress) !== null;
}

/**
 * Internal: create wallet and account from derived keys
 */
async function createWalletWithKeys(
  mainAddress: string,
  secret: Fr,
  salt: Fr,
  signingKey: Buffer,
): Promise<{ wallet: EmbeddedWallet; address: string }> {
  // Create EmbeddedWallet (starts local PXE)
  const nodeUrl = CHAINS.aztec.nodeUrl;
  console.log('[EmbeddedWallet] Creating EmbeddedWallet with node:', nodeUrl);
  console.log('[EmbeddedWallet] Environment check:', {
    crossOriginIsolated: typeof self !== 'undefined' ? (self as any).crossOriginIsolated : 'N/A',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 'N/A',
  });

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
    throw new Error(`bb.js WASM initialization failed: ${e.message || 'proc_exit called'}`);
  }

  const t0 = Date.now();
  const wallet = await EmbeddedWallet.create(nodeUrl);
  console.log('[EmbeddedWallet] Wallet created in', Date.now() - t0, 'ms');

  // Create ECDSA K account
  console.log('[EmbeddedWallet] Creating ECDSA K account...');
  const t1 = Date.now();
  const account = await wallet.createECDSAKAccount(secret, salt, signingKey);
  console.log('[EmbeddedWallet] Account created in', Date.now() - t1, 'ms');

  const aztecAddress = account.address.toString();
  console.log('[EmbeddedWallet] Account address:', aztecAddress);

  // Register SponsoredFPC for fee-free transactions
  try {
    console.log('[EmbeddedWallet] Registering SponsoredFPC...');
    const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
    const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');
    const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContract.artifact,
      { salt: new Fr(0) },
    );
    await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
    console.log('[EmbeddedWallet] SponsoredFPC registered at', sponsoredFPCInstance.address.toString());
  } catch (e: any) {
    console.warn('[EmbeddedWallet] Failed to register SponsoredFPC:', e.message);
  }

  // Deploy account on-chain if not already deployed (required for sending private txs)
  try {
    const { AztecAddress: AztecAddr } = await import('@aztec/aztec.js/addresses');
    const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
    const nodeClient = createAztecNodeClient(nodeUrl);
    const deployed = await nodeClient.getContract(AztecAddr.fromString(aztecAddress));
    if (!deployed) {
      console.log('[EmbeddedWallet] Account not deployed on-chain, deploying...');
      const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee/testing');
      const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
      const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');
      const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
        SponsoredFPCContract.artifact,
        { salt: new Fr(0) },
      );
      const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);
      const deployMethod = await account.getDeployMethod();
      const t2 = Date.now();
      await deployMethod.send({
        // New account deployment is initiated by the deployer entrypoint, not the
        // account itself. Using ZERO matches the working local create-account flow.
        from: AztecAddr.ZERO,
        fee: { paymentMethod },
        wait: { timeout: 300 },
      });
      console.log('[EmbeddedWallet] Account deployed in', Date.now() - t2, 'ms');
    } else {
      console.log('[EmbeddedWallet] Account already deployed on-chain');
    }
  } catch (e: any) {
    console.warn('[EmbeddedWallet] Account deployment failed (can retry later):', e.message);
  }

  // Register token contract (class + instance) so balance queries and transfers work
  const { CONTRACTS } = await import('@/config');
  const tokenAddress = CONTRACTS.aztec.token;
  if (tokenAddress) {
    try {
      console.log('[EmbeddedWallet] Registering token contract...');
      const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
      const { AztecAddress } = await import('@aztec/aztec.js/addresses');
      const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
      const tokenAddr = AztecAddress.fromString(tokenAddress);

      // Fetch the deployed contract instance from the node
      const nodeClient = createAztecNodeClient(nodeUrl);
      const contractInstance = await (nodeClient as any).getContract(tokenAddr);
      if (contractInstance) {
        await wallet.registerContract(contractInstance, TokenContract.artifact);
        console.log('[EmbeddedWallet] Token contract registered (class + instance)');
      } else {
        console.warn('[EmbeddedWallet] Token contract not found on node. Balance queries may fail.');
        // Fall back to class-only registration
        const pxe = (wallet as any).pxe;
        if (pxe?.registerContractClass) {
          await pxe.registerContractClass(TokenContract.artifact);
        }
      }
    } catch (e: any) {
      console.warn('[EmbeddedWallet] Failed to register token contract:', e.message);
    }
  }

  // PXE only discovers incoming private logs for known senders.
  // Add self and optional external senders (NEXT_PUBLIC_AZTEC_SENDER_ADDRESSES=0x...,0x...).
  await registerKnownSenders(wallet, aztecAddress);

  // Cache the wallet in memory
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
  clearCachedKeys();
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
