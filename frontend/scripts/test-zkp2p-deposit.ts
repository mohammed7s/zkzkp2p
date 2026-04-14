#!/usr/bin/env tsx
/**
 * Test zkp2p deposit using the new @zkp2p/sdk OfframpClient.
 *
 * Usage:
 *   npx tsx scripts/test-zkp2p-deposit.ts
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  erc20Abi,
  publicActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

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

const BASE_RPC = process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org';

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, msg);
}

async function main() {
  const {
    OfframpClient,
    SUPPORTED_CHAIN_IDS,
    getContracts,
  } = await import('@zkp2p/sdk');

  const CHAIN_ID = SUPPORTED_CHAIN_IDS.BASE_MAINNET;
  const { addresses } = getContracts(CHAIN_ID);

  log(`Chain: Base Mainnet (${CHAIN_ID})`);
  log(`Escrow: ${addresses.escrow}`);
  log(`USDC: ${addresses.usdc}`);

  const testKey = process.env.NEXT_PUBLIC_SOLVER_BASE_PRIVATE_KEY as Hex;
  if (!testKey) {
    console.error('Need NEXT_PUBLIC_SOLVER_BASE_PRIVATE_KEY in .env.local');
    process.exit(1);
  }

  const account = privateKeyToAccount(testKey);
  const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(BASE_RPC),
  });
  const receiptClient = walletClient.extend(publicActions);

  const balance = await publicClient.readContract({
    address: addresses.usdc as Hex,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  log(`Solver USDC balance: ${Number(balance) / 1e6} USDC`);

  if (balance === 0n) {
    log('No USDC. Fund the solver first.');
    return;
  }

  const client = new OfframpClient({
    walletClient: walletClient as any,
    chainId: CHAIN_ID,
  });

  const amount = 100000n; // 0.1 USDC
  const paymentMethod = 'revolut';
  const depositData = { revolutUsername: 'mohammgz8' };
  const conversionRates = [[{ currency: 'USD', conversionRate: '1020000000000000000' }]];

  log(`\nDeposit params:`);
  log(`  amount: ${amount} (${Number(amount) / 1e6} USDC)`);
  log(`  paymentMethod: ${paymentMethod}`);
  log(`  depositData: ${JSON.stringify(depositData)}`);

  log('\nEnsuring USDC allowance...');
  try {
    const allowanceResult = await client.ensureAllowance({
      token: addresses.usdc as Hex,
      amount,
      spender: addresses.escrow as Hex,
    });
    if (allowanceResult.hadAllowance) {
      log('Allowance OK');
    } else {
      log(`Approval submitted: ${allowanceResult.hash}`);
      await receiptClient.waitForTransactionReceipt({ hash: allowanceResult.hash });
      log('Approval confirmed');
    }
  } catch (e: any) {
    log(`Allowance failed: ${e.message}`);
  }

  log('\nCalling createDeposit...');
  try {
    const result = await client.createDeposit({
      token: addresses.usdc as Hex,
      amount,
      intentAmountRange: {
        min: amount / 10n,
        max: amount,
      },
      processorNames: [paymentMethod],
      depositData: [depositData],
      conversionRates,
      onSuccess: ({ hash }) => {
        log(`onSuccess callback - hash: ${hash}`);
      },
    });

    log(`SUCCESS! Result: ${JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
  } catch (e: any) {
    log(`FAILED: ${e.message}`);
    if (e.details) log(`Details: ${JSON.stringify(e.details)}`);
    if (e.stack) console.error(e.stack);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
