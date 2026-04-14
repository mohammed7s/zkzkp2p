#!/usr/bin/env tsx
/**
 * Deploy an Aztec Schnorr account on testnet using bridged fee juice.
 *
 * Reads keys + claim data from .aztec-account (created by create-account.ts).
 * Uses FEE_JUICE_WITH_CLAIM to claim bridged fee juice and pay for deployment
 * in a single transaction.
 *
 * Usage (from frontend/):
 *   npx tsx scripts/deploy-account.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL || 'https://rpc.testnet.aztec-labs.com';
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const ACCOUNT_FILE = resolve(__dirname, '..', '.aztec-account');

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, msg);
}

async function getMessageLeafIndex(bridgeTxHash: string, portalAddress: string): Promise<bigint> {
  // Parse the DepositToAztecPublic event from the bridge tx receipt
  // The messageLeafIndex is the last 32 bytes of the event data
  const res = await fetch(SEPOLIA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_getTransactionReceipt',
      params: [bridgeTxHash],
      id: 1,
    }),
  });
  const receipt = (await res.json()).result;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === portalAddress.toLowerCase()) {
      // DepositToAztecPublic event data: amount(32) + secretHash(32) + key(32) + index(32)
      const data = log.data.slice(2); // remove 0x
      const index = BigInt('0x' + data.slice(192, 256));
      return index;
    }
  }
  throw new Error('DepositToAztecPublic event not found in bridge tx logs');
}

async function main() {
  if (!existsSync(ACCOUNT_FILE)) {
    console.error('Error: .aztec-account not found. Run create-account.ts first.');
    process.exit(1);
  }

  const accountData = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf-8'));

  if (accountData.deployed) {
    console.log(`\n  Account already deployed: ${accountData.address}`);
    console.log(`  Next: npx tsx scripts/deploy-token.ts\n`);
    process.exit(0);
  }

  if (!accountData.claimSecret || !accountData.bridgeTxHash) {
    console.error('Error: .aztec-account missing claim data. Re-run create-account.ts.');
    process.exit(1);
  }

  log(`Account: ${accountData.address}`);

  // =========================================================================
  // Step 1: Get messageLeafIndex from L1 bridge tx
  // =========================================================================
  const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
  const node = createAztecNodeClient(AZTEC_NODE_URL);
  const nodeInfo = await node.getNodeInfo();
  const portalAddress = nodeInfo.l1ContractAddresses.feeJuicePortalAddress.toString();

  log('Fetching messageLeafIndex from L1 bridge tx...');
  const messageLeafIndex = await getMessageLeafIndex(accountData.bridgeTxHash, portalAddress);
  log(`messageLeafIndex: ${messageLeafIndex}`);

  // =========================================================================
  // Step 2: Create wallet and recover account
  // =========================================================================
  log('Creating EmbeddedWallet...');
  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { Fr } = await import('@aztec/aztec.js/fields');
  const { Fq } = await import('@aztec/foundation/curves/bn254');

  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });
  log('Wallet ready.');

  const secretKey = Fr.fromString(accountData.secretKey);
  const signingKey = Fq.fromString(accountData.signingKey);
  const salt = Fr.fromString(accountData.salt);
  const account = await wallet.createSchnorrAccount(secretKey, salt, signingKey);

  if (account.address.toString() !== accountData.address) {
    throw new Error(`Address mismatch: expected ${accountData.address}, got ${account.address}`);
  }
  log(`Account recovered: ${account.address}`);

  // =========================================================================
  // Step 3: Deploy with FeeJuicePaymentMethodWithClaim
  // =========================================================================
  log('Deploying account (claiming fee juice + deploying in one tx)...');

  const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee');
  const { GasSettings } = await import('@aztec/stdlib/gas');
  const { BaseWallet } = await import('@aztec/wallet-sdk/base-wallet');
  const { AztecAddress } = await import('@aztec/stdlib/aztec-address');

  const claimSecret = Fr.fromString(accountData.claimSecret);
  const claimAmount = BigInt(accountData.feeJuiceMinted);

  const paymentMethod = new FeeJuicePaymentMethodWithClaim(account.address, {
    claimAmount,
    claimSecret,
    messageLeafIndex,
  });

  // Get gas settings from the node
  const maxFeesPerGas = (await node.getCurrentMinFees()).mul(1.5);
  const gasSettings = GasSettings.default({ maxFeesPerGas });

  // Bypass EmbeddedWallet.sendTx pre-simulation (broken for account deploy in 4.2).
  // Use BaseWallet.sendTx which goes straight to proving.
  // Use NO_FROM (not AztecAddress.ZERO) — this tells BaseWallet to use the DefaultEntrypoint
  // (multicall) instead of trying to route through the undeployed account's entrypoint.
  const { BaseWallet: BW } = await import('@aztec/wallet-sdk/base-wallet');
  const { NO_FROM } = await import('@aztec/aztec.js/account');
  (wallet as any).sendTx = BW.prototype.sendTx.bind(wallet);

  const deployMethod = await account.getDeployMethod();
  log('Proving tx (this takes ~1 min)...');
  await deployMethod.send({
    from: NO_FROM as any,
    skipInstancePublication: false,
    skipClassPublication: false,
    fee: { paymentMethod, gasSettings },
    additionalScopes: [account.address],
    wait: { timeout: 600 },
  });
  log('Account deployed!');

  // Mark as deployed
  accountData.deployed = true;
  accountData.deployedAt = new Date().toISOString();
  accountData.messageLeafIndex = messageLeafIndex.toString();
  writeFileSync(ACCOUNT_FILE, JSON.stringify(accountData, null, 2));

  console.log('\n========================================');
  console.log('  Account Deployed!');
  console.log('========================================');
  console.log(`  Address: ${accountData.address}`);
  console.log('========================================');
  console.log('\nNext: npx tsx scripts/deploy-token.ts');

  await wallet.stop();
}

main().catch((err) => {
  console.error('\n  ✗ Failed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
