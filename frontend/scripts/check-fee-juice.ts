#!/usr/bin/env tsx
/**
 * Check if bridged fee juice has arrived on L2 by checking the L1 bridge tx
 * and estimating when the L1→L2 message should land.
 *
 * Usage: npx tsx scripts/check-fee-juice.ts
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

const accountFile = resolve(__dirname, '..', '.aztec-account');
const NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL || 'https://rpc.testnet.aztec-labs.com';
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

async function main() {
  if (!existsSync(accountFile)) {
    console.error('No .aztec-account found. Run create-account.ts first.');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(accountFile, 'utf-8'));
  console.log(`Account:    ${data.address}`);
  console.log(`Fee Juice:  ${data.feeJuiceMinted}`);
  console.log(`Bridge Tx:  ${data.bridgeTxHash}`);

  if (data.deployed) {
    console.log('\n✓ Account already deployed!');
    return;
  }

  // Check L1 tx timestamp
  const l1Res = await fetch(SEPOLIA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_getTransactionReceipt',
      params: [data.bridgeTxHash],
      id: 1,
    }),
  });
  const l1Receipt = (await l1Res.json()).result;
  const l1Block = parseInt(l1Receipt.blockNumber, 16);

  // Get current L1 block
  const l1CurRes = await fetch(SEPOLIA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
  });
  const l1CurBlock = parseInt((await l1CurRes.json()).result, 16);
  const l1BlocksElapsed = l1CurBlock - l1Block;

  console.log(`\nL1 bridge block:   ${l1Block}`);
  console.log(`Current L1 block:  ${l1CurBlock} (+${l1BlocksElapsed} blocks, ~${Math.floor(l1BlocksElapsed * 12 / 60)} mins ago)`);

  // Get current L2 block
  const l2Res = await fetch(NODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'node_getBlockNumber', params: [], id: 1 }),
  });
  const l2Block = (await l2Res.json()).result;
  console.log(`Current L2 block:  ${l2Block}`);

  // Check if account contract is already on-chain
  const contractRes = await fetch(NODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'node_getContract', params: [data.address], id: 1 }),
  });
  const contract = (await contractRes.json()).result;

  if (contract) {
    console.log('\n✓ Account contract deployed on-chain!');
    return;
  }

  // Estimate: L1→L2 messages typically land within ~15-20 min (depends on sequencer)
  const estimatedMins = 20;
  const elapsedMins = Math.floor(l1BlocksElapsed * 12 / 60);

  if (elapsedMins >= estimatedMins) {
    console.log(`\n~${elapsedMins} mins elapsed. Fee juice should have arrived.`);
    console.log('Try deploying: npx tsx scripts/deploy-account.ts');
    console.log('(If it fails with "Insufficient fee payer balance", wait a bit more.)');
  } else {
    const remaining = estimatedMins - elapsedMins;
    console.log(`\n~${elapsedMins} of ~${estimatedMins} mins elapsed. ~${remaining} mins remaining.`);
    console.log('Run this script again in a few minutes to check.');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
