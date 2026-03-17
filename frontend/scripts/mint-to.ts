#!/usr/bin/env tsx
/**
 * Mint tokens to a target Aztec address (public and/or private).
 *
 * Usage (from frontend/):
 *   npx tsx scripts/mint-to.ts <target-aztec-address> [amount] [--private]
 *
 * Examples:
 *   npx tsx scripts/mint-to.ts 0x1310...c424          # 1000 USDC public
 *   npx tsx scripts/mint-to.ts 0x1310...c424 500      # 500 USDC public
 *   npx tsx scripts/mint-to.ts 0x1310...c424 500 --private  # 500 public + 500 private
 *
 * Uses the account from .aztec-account (must be token admin).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
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

const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL || 'https://v4-devnet-2.aztec-labs.com';
const TOKEN_ADDRESS = process.env.NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS;
const ACCOUNT_FILE = resolve(__dirname, '..', '.aztec-account');
const TOKEN_DECIMALS = 6;

// Args
const targetAddress = process.argv[2];
const mintAmount = parseFloat(process.argv[3] || '1000');
const alsoPrivate = process.argv.includes('--private');

if (!targetAddress) {
  console.error('Usage: npx tsx scripts/mint-to.ts <target-aztec-address> [amount] [--private]');
  process.exit(1);
}

if (!TOKEN_ADDRESS) {
  console.error('Error: NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS not set in .env.local');
  process.exit(1);
}

function log(msg: string, data?: any) {
  const ts = new Date().toISOString().slice(11, 23);
  if (data !== undefined) {
    console.log(`[${ts}]`, msg, typeof data === 'bigint' ? data.toString() : data);
  } else {
    console.log(`[${ts}]`, msg);
  }
}

async function main() {
  if (!existsSync(ACCOUNT_FILE)) {
    console.error('Error: .aztec-account not found. Run create-account.ts first.');
    process.exit(1);
  }
  const accountData = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf-8'));

  log(`Admin: ${accountData.address}`);
  log(`Token: ${TOKEN_ADDRESS}`);
  log(`Target: ${targetAddress}`);
  log(`Amount: ${mintAmount} USDC (public${alsoPrivate ? ' + private' : ''})`);

  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { Fr, GrumpkinScalar } = await import('@aztec/aztec.js/fields');
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee/testing');
  const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
  const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');

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

  // Recover admin account
  const secretKey = Fr.fromString(accountData.secretKey);
  const signingKey = GrumpkinScalar.fromString(accountData.signingKey);
  const salt = Fr.fromString(accountData.salt);
  const account = await wallet.createSchnorrAccount(secretKey, salt, signingKey);
  const adminAddress = account.address;
  log(`Admin address: ${adminAddress.toString()}`);

  // Register token contract in PXE (needed for private functions)
  const tokenAddr = AztecAddress.fromString(TOKEN_ADDRESS!);
  log('Registering token contract in PXE...');
  const node = createAztecNodeClient(AZTEC_NODE_URL);
  const tokenInstance = await node.getContract(tokenAddr);

  if (tokenInstance) {
    await wallet.registerContract(tokenInstance, TokenContract.artifact);
    log('Token contract registered in PXE.');
  } else {
    const msg = `Token contract not found on node at ${tokenAddr.toString()}. Check NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS.`;
    if (alsoPrivate) {
      throw new Error(msg);
    }
    log(`WARNING: ${msg} Private functions will fail.`);
  }

  const token = await TokenContract.at(tokenAddr, wallet);

  const targetAddr = AztecAddress.fromString(targetAddress);
  const rawAmount = BigInt(Math.round(mintAmount * (10 ** TOKEN_DECIMALS)));
  const sendOpts = { from: adminAddress, fee: { paymentMethod }, wait: { timeout: 300 } };

  // 1. Mint public
  log(`Minting ${mintAmount} USDC publicly to target...`);
  const pubReceipt = await token.methods
    .mint_to_public(targetAddr, rawAmount)
    .send(sendOpts);
  log(`Public mint confirmed! Block: ${pubReceipt.blockNumber}, tx: ${pubReceipt.txHash.toString()}`);

  // 2. Optionally mint private (directly via mint_to_private)
  if (alsoPrivate) {
    log(`Minting ${mintAmount} USDC privately to target...`);
    const privReceipt = await token.methods
      .mint_to_private(targetAddr, rawAmount)
      .send(sendOpts);
    log(`Private mint confirmed! Block: ${privReceipt.blockNumber}, tx: ${privReceipt.txHash.toString()}`);
  }

  // Check public balance (requires simulate options in this SDK version)
  try {
    const pubBal = await token.methods.balance_of_public(targetAddr).simulate({
      from: adminAddress,
    });
    log(`Target public balance: ${Number(pubBal) / (10 ** TOKEN_DECIMALS)} USDC`);
  } catch (e: any) {
    log(`Could not read public balance: ${e.message}`);
  }

  if (alsoPrivate) {
    log(
      'Private mint submitted successfully. Note: private balance visibility depends on the recipient wallet keys/indexer (Azguard may not display custom token private notes).'
    );
  }

  console.log('\nDone!');
  await wallet.stop();
}

main().catch((err) => {
  console.error('\nFailed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
