#!/usr/bin/env tsx
/**
 * Create a new Aztec Schnorr account on devnet and save the keys.
 *
 * Usage (from frontend/):
 *   npx tsx scripts/create-account.ts
 *
 * Keys are saved to frontend/.aztec-account (gitignored).
 * The account is deployed on-chain with fees paid by SponsoredFPC.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
const envPath = resolve(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL || 'https://v4-devnet-2.aztec-labs.com';
const ACCOUNT_FILE = resolve(__dirname, '..', '.aztec-account');

function log(msg: string, data?: any) {
  const ts = new Date().toISOString().slice(11, 23);
  if (data !== undefined) {
    console.log(`[${ts}]`, msg, typeof data === 'bigint' ? data.toString() : data);
  } else {
    console.log(`[${ts}]`, msg);
  }
}

async function main() {
  // Check if account already exists
  if (existsSync(ACCOUNT_FILE)) {
    const existing = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf-8'));
    console.log('\n  Account already exists at .aztec-account:');
    console.log(`    Address:     ${existing.address}`);
    console.log(`    Secret Key:  ${existing.secretKey}`);
    console.log(`    Signing Key: ${existing.signingKey}`);
    console.log(`\n  To create a new one, delete .aztec-account first.`);
    console.log(`  To deploy a token: AZTEC_SECRET_KEY=${existing.secretKey} npx tsx scripts/deploy-token.ts\n`);
    process.exit(0);
  }

  // Dynamic imports
  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { Fr, GrumpkinScalar } = await import('@aztec/aztec.js/fields');
  const { AztecAddress } = await import('@aztec/stdlib/aztec-address');
  const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee/testing');
  const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
  const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');

  // 1. Create EmbeddedWallet (runs a local PXE in Node.js — has SharedArrayBuffer)
  log(`Creating EmbeddedWallet connected to ${AZTEC_NODE_URL}...`);
  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });
  log('EmbeddedWallet ready.');

  // 2. Register SponsoredFPC
  log('Registering SponsoredFPC for fee payment...');
  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
  const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);
  log(`SponsoredFPC registered at: ${sponsoredFPCInstance.address.toString()}`);

  // 3. Generate random keys and create account
  log('Generating keys and creating Schnorr account...');
  const secretKey = Fr.random();
  const signingKey = GrumpkinScalar.random();
  const salt = Fr.random();

  const account = await wallet.createSchnorrAccount(secretKey, salt, signingKey);
  const address = account.address;
  log(`Account address: ${address.toString()}`);

  // 4. Deploy account on-chain
  log('Deploying account on-chain (fees paid by SponsoredFPC)...');
  const deployMethod = await account.getDeployMethod();
  const sentTx = await deployMethod.send({
    from: AztecAddress.ZERO,
    fee: { paymentMethod },
  });
  // send() returns a TxHash wrapped object — extract the hash
  const txHash = sentTx?.toString?.() ?? sentTx;
  log(`Transaction sent: ${txHash}`);
  log('Waiting for confirmation (this may take a minute)...');
  // Poll getTxReceipt on the PXE
  const pxe = (wallet as any).pxe;
  const { TxStatus } = await import('@aztec/stdlib/tx');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const receipt = await pxe.getTxReceipt(sentTx);
      if (receipt && receipt.status === TxStatus.SUCCESS) {
        log(`Account deployed! Block: ${receipt.blockNumber}`);
        break;
      } else if (receipt && receipt.status !== TxStatus.PENDING) {
        log(`Tx status: ${receipt.status}`);
        break;
      }
    } catch {
      // receipt not available yet
    }
  }

  // 5. Save keys to file
  const accountData = {
    address: address.toString(),
    secretKey: secretKey.toString(),
    signingKey: signingKey.toString(),
    salt: salt.toString(),
    network: AZTEC_NODE_URL,
    createdAt: new Date().toISOString(),
  };

  writeFileSync(ACCOUNT_FILE, JSON.stringify(accountData, null, 2));
  log(`Keys saved to ${ACCOUNT_FILE}`);

  // 6. Summary
  console.log('\n========================================');
  console.log('  Aztec Account Created');
  console.log('========================================');
  console.log(`  Address:     ${accountData.address}`);
  console.log(`  Secret Key:  ${accountData.secretKey}`);
  console.log(`  Signing Key: ${accountData.signingKey}`);
  console.log(`  Salt:        ${accountData.salt}`);
  console.log(`  Network:     ${accountData.network}`);
  console.log(`  Saved to:    .aztec-account`);
  console.log('========================================');
  console.log(`\nNext steps:`);
  console.log(`  AZTEC_SECRET_KEY=${accountData.secretKey} npx tsx scripts/deploy-token.ts`);
  console.log();

  await wallet.stop();
}

main().catch((err) => {
  console.error('\n  ✗ Account creation failed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
