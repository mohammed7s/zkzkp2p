#!/usr/bin/env tsx
/**
 * Deploy a Token contract on Aztec devnet and mint tokens for testing.
 *
 * Usage (from frontend/):
 *   npx tsx scripts/deploy-token.ts
 *
 * Reads account keys from .aztec-account (created by create-account.ts).
 * Deploys TokenContract and mints tokens using SponsoredFPC for fees.
 */

import { readFileSync, existsSync } from 'fs';
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
const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL || 'https://rpc.testnet.aztec-labs.com';
const ACCOUNT_FILE = resolve(__dirname, '..', '.aztec-account');

const TOKEN_NAME = process.env.TOKEN_NAME || 'Test USDC';
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'tUSDC';
const TOKEN_DECIMALS = parseInt(process.env.TOKEN_DECIMALS || '6');
const MINT_AMOUNT = parseFloat(process.env.MINT_AMOUNT || '10000');

function log(msg: string, data?: any) {
  const ts = new Date().toISOString().slice(11, 23);
  if (data !== undefined) {
    console.log(`[${ts}]`, msg, typeof data === 'bigint' ? data.toString() : data);
  } else {
    console.log(`[${ts}]`, msg);
  }
}

async function main() {
  // Load account keys
  if (!existsSync(ACCOUNT_FILE)) {
    console.error('Error: .aztec-account not found. Run create-account.ts first.');
    process.exit(1);
  }
  const accountData = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf-8'));
  log(`Using account: ${accountData.address}`);

  // Dynamic imports
  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { Fr } = await import('@aztec/aztec.js/fields');
  const { Fq } = await import('@aztec/foundation/curves/bn254');
  const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee/testing');
  const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');

  // 1. Create EmbeddedWallet with prover
  log(`Creating EmbeddedWallet connected to ${AZTEC_NODE_URL}...`);
  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });
  log('EmbeddedWallet ready.');

  // 2. Register SponsoredFPC
  log('Registering SponsoredFPC...');
  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
  const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);

  // 3. Recover existing account
  log('Recovering Schnorr account...');
  const secretKey = Fr.fromString(accountData.secretKey);
  const signingKey = Fq.fromString(accountData.signingKey);
  const salt = Fr.fromString(accountData.salt);
  const account = await wallet.createSchnorrAccount(secretKey, salt, signingKey);
  const myAddress = account.address;
  log(`Account address: ${myAddress.toString()}`);

  // 4. Deploy TokenContract
  log(`Deploying TokenContract: ${TOKEN_NAME} (${TOKEN_SYMBOL}), ${TOKEN_DECIMALS} decimals...`);
  const deployMethod = TokenContract.deploy(wallet, myAddress, TOKEN_NAME, TOKEN_SYMBOL, TOKEN_DECIMALS);
  const precomputedAddress = deployMethod.address?.toString();
  if (precomputedAddress) {
    log(`Precomputed token address: ${precomputedAddress}`);
  }

  const deployResult = await deployMethod.send({
    from: myAddress,
    fee: { paymentMethod },
    wait: { timeout: 300 },
  });
  // In 4.2, send() returns { receipt, txHash } — extract what we can
  const receipt = (deployResult as any).receipt ?? deployResult;
  log(`Deploy confirmed! tx: ${receipt.txHash?.toString?.() ?? (deployResult as any).txHash?.toString?.() ?? 'unknown'}`);

  // Use precomputed address (deterministic from deploy params)
  const tokenAddress = precomputedAddress ?? deployMethod.address?.toString();
  if (!tokenAddress) {
    throw new Error('Could not determine token address');
  }
  log(`Token address: ${tokenAddress}`);

  // 5. Mint tokens
  const mintAmount = BigInt(Math.round(MINT_AMOUNT * (10 ** TOKEN_DECIMALS)));
  log(`Minting ${MINT_AMOUNT} ${TOKEN_SYMBOL} publicly to ${myAddress.toString()}...`);

  const { AztecAddress: AztecAddr } = await import('@aztec/aztec.js/addresses');
  const tokenAddr = AztecAddr.fromString(tokenAddress);
  const token = await TokenContract.at(tokenAddr, wallet);

  const mintResult = await token.methods
    .mint_to_public(myAddress, mintAmount)
    .send({ from: myAddress, fee: { paymentMethod }, wait: { timeout: 300 } });
  const mintReceipt = (mintResult as any).receipt ?? mintResult;
  log(`Mint confirmed! tx: ${mintReceipt.txHash?.toString?.() ?? 'unknown'}`);

  // 6. Check balance
  try {
    const balance = await token.methods.balance_of_public(myAddress).simulate();
    log(`Public balance: ${Number(balance) / (10 ** TOKEN_DECIMALS)} ${TOKEN_SYMBOL}`);
  } catch (e: any) {
    log(`Could not read balance: ${e.message}`);
  }

  // 7. Summary
  console.log('\n========================================');
  console.log('  Token Deployment Summary');
  console.log('========================================');
  console.log(`  Name:     ${TOKEN_NAME}`);
  console.log(`  Symbol:   ${TOKEN_SYMBOL}`);
  console.log(`  Decimals: ${TOKEN_DECIMALS}`);
  console.log(`  Address:  ${tokenAddress}`);
  console.log(`  Admin:    ${myAddress.toString()}`);
  console.log(`  Minted:   ${MINT_AMOUNT} ${TOKEN_SYMBOL}`);
  console.log(`  Network:  ${AZTEC_NODE_URL}`);
  console.log('========================================');
  console.log(`\nAdd to .env.local:`);
  console.log(`  NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS=${tokenAddress}`);
  console.log();

  await wallet.stop();
}

main().catch((err) => {
  console.error('\n  ✗ Deployment failed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
