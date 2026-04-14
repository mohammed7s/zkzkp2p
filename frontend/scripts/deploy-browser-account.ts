#!/usr/bin/env tsx
/**
 * Deploy a browser-derived ECDSA-K account on testnet.
 *
 * Usage (from frontend/):
 *   TARGET_SECRET=0x... TARGET_SALT=0x... TARGET_SIGNING_KEY=0x... \
 *   npx tsx scripts/deploy-browser-account.ts
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
const SECRET = process.env.TARGET_SECRET;
const SALT = process.env.TARGET_SALT;
const SIGNING_KEY = process.env.TARGET_SIGNING_KEY;

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, msg);
}

async function main() {
  if (!SECRET || !SALT || !SIGNING_KEY) {
    console.error('Usage: TARGET_SECRET=0x... TARGET_SALT=0x... TARGET_SIGNING_KEY=0x... npx tsx scripts/deploy-browser-account.ts');
    process.exit(1);
  }

  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { Fr } = await import('@aztec/aztec.js/fields');
  const { NO_FROM } = await import('@aztec/aztec.js/account');
  const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee/testing');
  const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
  const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');
  const { GasSettings } = await import('@aztec/stdlib/gas');
  const { BaseWallet } = await import('@aztec/wallet-sdk/base-wallet');
  const { createAztecNodeClient } = await import('@aztec/aztec.js/node');

  log(`Connecting to ${AZTEC_NODE_URL}...`);
  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });
  log('Wallet ready.');

  // Register SponsoredFPC
  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
  const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);

  // Create ECDSA-K account from browser-derived keys
  const secret = Fr.fromString(SECRET);
  const salt = Fr.fromString(SALT);
  const signingKey = Buffer.from(SIGNING_KEY.replace('0x', ''), 'hex');
  const account = await wallet.createECDSAKAccount(secret, salt, signingKey);
  log(`Account: ${account.address.toString()}`);

  // Check if already deployed
  const node = createAztecNodeClient(AZTEC_NODE_URL);
  const existing = await node.getContract(account.address);
  if (existing) {
    log('Account already deployed!');
    await wallet.stop();
    return;
  }

  // Deploy
  log('Deploying ECDSA-K account (SponsoredFPC pays fees)...');
  const maxFeesPerGas = (await node.getCurrentMinFees()).mul(1.5);
  const gasSettings = GasSettings.default({ maxFeesPerGas });

  // Bypass EmbeddedWallet.sendTx pre-simulation AND patch getAccountFromAddress
  // to handle AztecAddress.ZERO (the published 4.2 package is missing this check).
  // We return a minimal "signerless" account that routes through DefaultEntrypoint.
  const { AztecAddress } = await import('@aztec/stdlib/aztec-address');
  const { DefaultEntrypoint } = await import('@aztec/entrypoints/default');

  (wallet as any).sendTx = BaseWallet.prototype.sendTx.bind(wallet);

  // Patch getAccountFromAddress to handle ZERO
  const origGetAccount = (wallet as any).getAccountFromAddress.bind(wallet);
  (wallet as any).getAccountFromAddress = async (addr: any) => {
    if (addr.equals(AztecAddress.ZERO)) {
      // Return a minimal account that uses DefaultEntrypoint
      const entrypoint = new DefaultEntrypoint();
      return {
        createTxExecutionRequest: entrypoint.createTxExecutionRequest.bind(entrypoint),
      };
    }
    return origGetAccount(addr);
  };

  const deployMethod = await account.getDeployMethod();
  log('Proving tx...');
  await deployMethod.send({
    from: AztecAddress.ZERO,
    skipInstancePublication: false,
    skipClassPublication: false,
    fee: { paymentMethod, gasSettings },
    additionalScopes: [account.address],
    wait: { timeout: 600 },
  });

  log('Account deployed!');
  console.log(`\nAddress: ${account.address.toString()}`);
  console.log('You can now receive private notes at this address.');

  await wallet.stop();
}

main().catch((err) => {
  console.error('\nFailed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
