#!/usr/bin/env tsx
/**
 * Create a new Aztec Schnorr account on testnet.
 *
 * 1. Generate keys and compute address (no PXE needed)
 * 2. Mint + bridge fee juice from Sepolia L1 to L2
 * 3. Deploy account contract on L2 using fee juice
 *
 * Usage (from frontend/):
 *   SEPOLIA_PRIVATE_KEY=0x... npx tsx scripts/create-account.ts
 *
 * Requires: Sepolia wallet with some ETH for gas.
 * Keys are saved to frontend/.aztec-account (gitignored).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

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
const SEPOLIA_KEY = process.env.SEPOLIA_PRIVATE_KEY as Hex | undefined;
const ACCOUNT_FILE = resolve(__dirname, '..', '.aztec-account');

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, msg);
}

async function main() {
  if (existsSync(ACCOUNT_FILE)) {
    const existing = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf-8'));
    console.log(`\n  Account already exists: ${existing.address}`);
    console.log(`  Delete .aztec-account to create a new one.\n`);
    process.exit(0);
  }

  if (!SEPOLIA_KEY) {
    console.error('Error: SEPOLIA_PRIVATE_KEY env var required (Sepolia wallet with ETH for gas)');
    console.error('Usage: SEPOLIA_PRIVATE_KEY=0x... npx tsx scripts/create-account.ts');
    process.exit(1);
  }

  // =========================================================================
  // Step 1: Generate keys and compute L2 address (pure crypto, no PXE)
  // =========================================================================
  log('Generating keys...');
  const { Fr } = await import('@aztec/aztec.js/fields');
  const { Fq } = await import('@aztec/foundation/curves/bn254');
  const { getSchnorrAccountContractAddress } = await import('@aztec/accounts/schnorr');

  const secretKey = Fr.random();
  const signingKey = Fq.random();
  const salt = Fr.random();

  const address = await getSchnorrAccountContractAddress(secretKey, salt, signingKey);
  log(`Account address: ${address.toString()}`);

  // =========================================================================
  // Step 2: Get L1 contract addresses from the Aztec node
  // =========================================================================
  log('Fetching L1 contract addresses from Aztec node...');
  const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
  const node = createAztecNodeClient(AZTEC_NODE_URL);
  const nodeInfo = await node.getNodeInfo();
  const {
    feeJuiceAddress,
    feeJuicePortalAddress,
    feeAssetHandlerAddress,
  } = nodeInfo.l1ContractAddresses;

  log(`Fee Juice (L1 ERC20): ${feeJuiceAddress}`);
  log(`Fee Juice Portal: ${feeJuicePortalAddress}`);
  log(`Fee Asset Handler (mint): ${feeAssetHandlerAddress}`);

  // =========================================================================
  // Step 3: Mint fee juice on L1 and bridge to L2
  // =========================================================================
  const sepoliaAccount = privateKeyToAccount(SEPOLIA_KEY);
  log(`Sepolia wallet: ${sepoliaAccount.address}`);

  const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
  const walletClient = createWalletClient({
    account: sepoliaAccount,
    chain: sepolia,
    transport: http(SEPOLIA_RPC),
  });

  // Mint fee juice via FeeAssetHandler
  const { FeeAssetHandlerAbi } = await import('@aztec/l1-artifacts/FeeAssetHandlerAbi');
  const handler = getContract({
    address: feeAssetHandlerAddress.toString() as Hex,
    abi: FeeAssetHandlerAbi,
    client: walletClient,
  });

  const mintAmount = await handler.read.mintAmount();
  log(`Minting ${mintAmount} fee juice tokens on L1...`);
  const mintHash = await handler.write.mint([sepoliaAccount.address]);
  await publicClient.waitForTransactionReceipt({ hash: mintHash });
  log('Minted!');

  // Approve portal to spend
  const { TestERC20Abi } = await import('@aztec/l1-artifacts/TestERC20Abi');
  const feeJuiceToken = getContract({
    address: feeJuiceAddress.toString() as Hex,
    abi: TestERC20Abi,
    client: walletClient,
  });

  log('Approving Fee Juice Portal...');
  const approveHash = await feeJuiceToken.write.approve([
    feeJuicePortalAddress.toString() as Hex,
    mintAmount,
  ]);
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // Bridge to L2
  const { FeeJuicePortalAbi } = await import('@aztec/l1-artifacts/FeeJuicePortalAbi');
  const { computeSecretHash } = await import('@aztec/stdlib/hash');

  const claimSecret = Fr.random();
  const claimSecretHash = await computeSecretHash(claimSecret);

  const portal = getContract({
    address: feeJuicePortalAddress.toString() as Hex,
    abi: FeeJuicePortalAbi,
    client: walletClient,
  });

  log(`Bridging ${mintAmount} fee juice to L2 address ${address.toString().slice(0, 20)}...`);
  const bridgeHash = await portal.write.depositToAztecPublic([
    address.toString() as Hex,
    mintAmount,
    claimSecretHash.toString() as Hex,
  ]);
  const bridgeReceipt = await publicClient.waitForTransactionReceipt({ hash: bridgeHash });
  log(`Bridged! L1 tx: ${bridgeReceipt.transactionHash}`);

  // =========================================================================
  // Step 4: Save keys (deploy will happen separately after L1→L2 message lands)
  // =========================================================================
  const accountData = {
    address: address.toString(),
    secretKey: secretKey.toString(),
    signingKey: signingKey.toString(),
    salt: salt.toString(),
    network: AZTEC_NODE_URL,
    claimSecret: claimSecret.toString(),
    claimSecretHash: claimSecretHash.toString(),
    bridgeTxHash: bridgeReceipt.transactionHash,
    feeJuiceMinted: mintAmount.toString(),
    createdAt: new Date().toISOString(),
  };

  writeFileSync(ACCOUNT_FILE, JSON.stringify(accountData, null, 2));

  console.log('\n========================================');
  console.log('  Aztec Account Keys Generated');
  console.log('========================================');
  console.log(`  Address:      ${accountData.address}`);
  console.log(`  Secret Key:   ${accountData.secretKey}`);
  console.log(`  Signing Key:  ${accountData.signingKey}`);
  console.log(`  Salt:         ${accountData.salt}`);
  console.log(`  Network:      ${accountData.network}`);
  console.log(`  Fee Juice:    ${accountData.feeJuiceMinted} (bridging from L1)`);
  console.log(`  L1 Bridge Tx: ${accountData.bridgeTxHash}`);
  console.log('========================================');
  console.log('\nFee juice is bridging from L1 → L2 (takes ~15-20 mins).');
  console.log('Then deploy the account:');
  console.log('  npx tsx scripts/deploy-account.ts');
  console.log();
}

main().catch((err) => {
  console.error('\n  ✗ Failed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
