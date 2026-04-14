#!/usr/bin/env tsx
/**
 * Check public and private token balances for an Aztec account.
 *
 * Usage (from frontend/):
 *   npx tsx scripts/check-balances.ts [address]
 *
 * If no address given, uses the account from .aztec-account.
 * Uses the admin account keys to set up PXE (needed for private balance decryption).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
const envPath = resolve(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL || 'https://rpc.testnet.aztec-labs.com';
const TOKEN_ADDRESS = process.env.NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS;
const ACCOUNT_FILE = resolve(__dirname, '..', '.aztec-account');

async function main() {
  if (!TOKEN_ADDRESS) {
    console.error('Error: NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS not set in .env.local');
    process.exit(1);
  }

  // Load admin account
  if (!existsSync(ACCOUNT_FILE)) {
    console.error('Error: .aztec-account not found. Run create-account.ts first.');
    process.exit(1);
  }
  const accountData = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf-8'));

  // Target address — argument or default to admin
  const targetAddress = process.argv[2] || accountData.address;

  console.log(`Network:  ${AZTEC_NODE_URL}`);
  console.log(`Token:    ${TOKEN_ADDRESS}`);
  console.log(`Account:  ${targetAddress}`);
  console.log();

  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { Fr } = await import('@aztec/aztec.js/fields');
  const { Fq } = await import('@aztec/foundation/curves/bn254');
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  const { createAztecNodeClient } = await import('@aztec/aztec.js/node');

  // Create wallet with admin keys (needed for PXE to decrypt private notes)
  console.log('Starting PXE...');
  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL, {
    ephemeral: true,
    pxeConfig: { proverEnabled: false },
  });

  // Register admin account (Schnorr)
  const secretKey = Fr.fromString(accountData.secretKey);
  const signingKey = Fq.fromString(accountData.signingKey);
  const salt = Fr.fromString(accountData.salt);
  await wallet.createSchnorrAccount(secretKey, salt, signingKey);

  const targetAddr = AztecAddress.fromString(targetAddress);
  const adminAddr = AztecAddress.fromString(accountData.address);

  // If target has keys provided via env vars, register that account too (ECDSA-K)
  // Usage: TARGET_SECRET=0x... TARGET_SALT=0x... TARGET_SIGNING_KEY=0x... npx tsx scripts/check-balances.ts <address>
  const targetSecret = process.env.TARGET_SECRET;
  const targetSalt = process.env.TARGET_SALT;
  const targetSigningKey = process.env.TARGET_SIGNING_KEY;
  let canCheckTargetPrivate = targetAddress.toLowerCase() === accountData.address.toLowerCase();

  if (targetSecret && targetSalt && targetSigningKey && !canCheckTargetPrivate) {
    try {
      const tSecret = Fr.fromString(targetSecret);
      const tSalt = Fr.fromString(targetSalt);
      const tSigningKey = Buffer.from(targetSigningKey.replace('0x', ''), 'hex');
      const targetAccount = await wallet.createECDSAKAccount(tSecret, tSalt, tSigningKey);
      const derivedTarget = targetAccount.address.toString();
      console.log(`Registered target ECDSA-K account: ${derivedTarget}`);
      if (derivedTarget.toLowerCase() === targetAddress.toLowerCase()) {
        canCheckTargetPrivate = true;
      } else {
        console.log(`WARNING: Target keys derive ${derivedTarget}, not requested account ${targetAddress}`);
      }
    } catch (e: any) {
      console.log(`Failed to register target account: ${e.message}`);
    }
  }

  // Register senders so PXE scans for notes
  if (targetAddress.toLowerCase() !== accountData.address.toLowerCase()) {
    try { await wallet.registerSender(targetAddr, 'target'); } catch {}
  }
  try { await wallet.registerSender(adminAddr, 'self'); } catch {}

  // Register token contract
  const tokenAddr = AztecAddress.fromString(TOKEN_ADDRESS);
  const node = createAztecNodeClient(AZTEC_NODE_URL);
  const tokenInstance = await node.getContract(tokenAddr);
  if (!tokenInstance) {
    console.error(`Token contract not found on-chain at ${TOKEN_ADDRESS}`);
    process.exit(1);
  }
  await wallet.registerContract(tokenInstance, TokenContract.artifact);

  // Wait for PXE to sync (ephemeral PXE needs to scan for private notes)
  const pxe = (wallet as any).pxe;
  console.log('Waiting for PXE to sync...');
  const nodeBlock = await node.getBlockNumber();
  for (let i = 0; i < 120; i++) {
    try {
      const header = await pxe.getSyncedBlockHeader();
      const pxeBlock = Number(header?.globalVariables?.blockNumber ?? 0);
      if (pxeBlock >= nodeBlock - 1) {
        console.log(`PXE synced to block ${pxeBlock} (node at ${nodeBlock})`);
        break;
      }
      if (i % 5 === 0) {
        console.log(`PXE at block ${pxeBlock}/${nodeBlock}, waiting...`);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }

  const token = await TokenContract.at(tokenAddr, wallet);

  // Helper to extract bigint from simulate result (may be Fr, object with value, or nested)
  function extractBigInt(result: any): bigint {
    if (typeof result === 'bigint') return result;
    if (typeof result === 'number') return BigInt(result);
    if (typeof result === 'string') return BigInt(result);
    // Fr or field-like object
    if (result?.toBigInt) return result.toBigInt();
    if (result?.toNumber) return BigInt(result.toNumber());
    if (result?.result !== undefined) return extractBigInt(result.result);
    if (result?.value !== undefined) return extractBigInt(result.value);
    if (result?.inner !== undefined) return extractBigInt(result.inner);
    // Array-like (simulation may return [value])
    if (Array.isArray(result) && result.length > 0) return extractBigInt(result[0]);
    // Log it for debugging
    console.log('  DEBUG result:', JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    throw new Error('Cannot extract balance from result');
  }

  // Check public balance
  console.log('Checking public balance...');
  try {
    const pubBal = await token.methods.balance_of_public(targetAddr).simulate({
      from: adminAddr,
    });
    const pubAmount = extractBigInt(pubBal);
    console.log(`  Public:  ${formatAmount(pubAmount)} tUSDC (${pubAmount} raw)`);
  } catch (e: any) {
    console.log(`  Public:  error - ${e.message}`);
  }

  // Check private balance (only works if target is the admin — PXE needs the secret key)
  console.log('Checking private balance...');
  if (canCheckTargetPrivate) {
    try {
      const privBal = await token.methods.balance_of_private(targetAddr).simulate({
        from: targetAddr,
      });
      const privAmount = extractBigInt(privBal);
      console.log(`  Private: ${formatAmount(privAmount)} tUSDC (${privAmount} raw)`);
    } catch (e: any) {
      console.log(`  Private: error - ${e.message}`);
    }
  } else {
    console.log(`  Private: N/A (can only check private balance for the admin account)`);
    console.log(`           Private notes are encrypted — only the owner's PXE can decrypt them.`);
    console.log(`           To check ${targetAddress.slice(0, 20)}...'s private balance,`);
    console.log(`           import their secret key into a wallet/PXE.`);
  }

  console.log();
  await wallet.stop();
}

function formatAmount(raw: bigint, decimals = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
