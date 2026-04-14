#!/usr/bin/env tsx
/**
 * Publish an already-deployed account's contract instance to the registry.
 * This makes the account's public keys discoverable by other contracts,
 * which is required for receiving private notes.
 *
 * Usage:
 *   TARGET_SECRET=0x... TARGET_SALT=0x... TARGET_SIGNING_KEY=0x... \
 *   npx tsx scripts/publish-account.ts
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

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
const ACCOUNT_FILE = resolve(__dirname, '..', '.aztec-account');
const SECRET = process.env.TARGET_SECRET;
const SALT = process.env.TARGET_SALT;
const SIGNING_KEY = process.env.TARGET_SIGNING_KEY;

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, msg);
}

async function main() {
  if (!SECRET || !SALT || !SIGNING_KEY) {
    console.error('Usage: TARGET_SECRET=0x... TARGET_SALT=0x... TARGET_SIGNING_KEY=0x... npx tsx scripts/publish-account.ts');
    process.exit(1);
  }

  // We need the admin account to send the publish tx (it has fee juice)
  if (!existsSync(ACCOUNT_FILE)) {
    console.error('Error: .aztec-account not found (need admin account for fees)');
    process.exit(1);
  }
  const adminData = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf-8'));

  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { Fr } = await import('@aztec/aztec.js/fields');
  const { Fq } = await import('@aztec/foundation/curves/bn254');
  const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
  const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee/testing');
  const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
  const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');

  log(`Connecting to ${AZTEC_NODE_URL}...`);

  // IMPORTANT: Register accounts BEFORE creating the wallet so the PXE
  // indexes their nullifiers during sync. We do this by creating the wallet
  // with a pre-registration hook.
  //
  // Actually, EmbeddedWallet registers accounts after creation. So we need
  // to create a custom flow: create wallet, register accounts, THEN let it sync.

  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL, {
    ephemeral: false,
    pxeConfig: { proverEnabled: true },
  });
  log('Wallet ready.');

  // Register admin account FIRST (before sync catches up)
  const adminSecret = Fr.fromString(adminData.secretKey);
  const adminSigningKey = Fq.fromString(adminData.signingKey);
  const adminSalt = Fr.fromString(adminData.salt);
  await wallet.createSchnorrAccount(adminSecret, adminSalt, adminSigningKey);
  log(`Admin: ${adminData.address}`);

  // Register target account BEFORE sync (so PXE indexes its nullifiers)
  const targetSecret = Fr.fromString(SECRET);
  const targetSalt = Fr.fromString(SALT);
  const targetSigningKey = Buffer.from(SIGNING_KEY.replace('0x', ''), 'hex');
  const targetAccount = await wallet.createECDSAKAccount(targetSecret, targetSalt, targetSigningKey);
  log(`Target: ${targetAccount.address.toString()}`);
  log(`Instance class: ${targetAccount.getInstance().currentContractClassId.toString()}`);

  // NOW wait for PXE to sync (it will index nullifiers for both registered accounts)
  const { createAztecNodeClient: createNode } = await import('@aztec/aztec.js/node');
  const syncNode = createNode(AZTEC_NODE_URL);
  const nodeBlock = await syncNode.getBlockNumber();
  log(`Node at block ${nodeBlock}. Waiting for PXE to sync...`);
  const pxe = (wallet as any).pxe;
  for (let i = 0; i < 180; i++) {
    try {
      const header = await pxe.getSyncedBlockHeader();
      const pxeBlock = Number(header?.globalVariables?.blockNumber ?? 0);
      if (pxeBlock >= nodeBlock - 2) {
        log(`PXE synced to block ${pxeBlock}`);
        break;
      }
      if (i % 10 === 0) log(`PXE at block ${pxeBlock}/${nodeBlock}...`);
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }

  // Register SponsoredFPC
  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
  const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);

  // Get the contract instance from the already-registered target account
  const instance = targetAccount.getInstance();

  // Publish the instance using the InstanceRegistry
  // This is done via a public call to the InstanceRegistry contract
  const { AztecAddress } = await import('@aztec/stdlib/aztec-address');
  const { publishInstance } = await import('@aztec/aztec.js/deployment');

  const adminAddr = AztecAddress.fromString(adminData.address);
  log('Publishing contract instance to registry...');

  const result = await publishInstance(wallet, instance).send({
    from: adminAddr,
    fee: { paymentMethod },
    wait: { timeout: 300 },
  });
  log('Instance published!');

  // Verify
  const node = createAztecNodeClient(AZTEC_NODE_URL);
  const verified = await node.getContract(targetAccount.address);
  log(`Verified on-chain: ${!!verified}`);

  await wallet.stop();
}

main().catch((err) => {
  console.error('\nFailed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
