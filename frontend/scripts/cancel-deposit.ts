#!/usr/bin/env tsx
/**
 * Withdraw/cancel a deposit on peer.xyz
 *
 * Usage:
 *   npx tsx scripts/cancel-deposit.ts <depositId>
 *   npx tsx scripts/cancel-deposit.ts 764
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

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

const BASE_RPC = process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org';
const depositId = process.argv[2];

if (!depositId) {
  console.error('Usage: npx tsx scripts/cancel-deposit.ts <depositId>');
  process.exit(1);
}

async function main() {
  const { OfframpClient, SUPPORTED_CHAIN_IDS } = await import('@zkp2p/sdk');

  const testKey = process.env.NEXT_PUBLIC_SOLVER_BASE_PRIVATE_KEY as Hex;
  if (!testKey) {
    console.error('Need NEXT_PUBLIC_SOLVER_BASE_PRIVATE_KEY');
    process.exit(1);
  }

  const account = privateKeyToAccount(testKey);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(BASE_RPC),
  });

  const client = new OfframpClient({
    walletClient: walletClient as any,
    chainId: SUPPORTED_CHAIN_IDS.BASE_MAINNET,
  });

  console.log(`Withdrawing deposit #${depositId} from ${account.address}...`);

  try {
    const result = await (client as any).withdrawDeposit({ depositId: BigInt(depositId) });
    console.log('Withdrawn!', result);
  } catch (e: any) {
    console.log(`withdrawDeposit failed: ${e.message}`);
    console.log('Trying removeFunds...');
    try {
      // Try getting deposit first to know the amount
      const deposit = await client.getDeposit(BigInt(depositId));
      console.log('Deposit:', JSON.stringify(deposit, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));

      const remaining = BigInt((deposit as any)?.remainingDeposits?.toString() || (deposit as any)?.amount?.toString() || '0');
      if (remaining > 0n) {
        const result2 = await (client as any).removeFunds({ depositId: BigInt(depositId), amount: remaining });
        console.log('Removed funds!', result2);
      } else {
        console.log('No remaining funds to remove');
      }
    } catch (e2: any) {
      console.error('removeFunds also failed:', e2.message);
    }
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
