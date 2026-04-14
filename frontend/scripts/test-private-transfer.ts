#!/usr/bin/env tsx
/**
 * Direct Aztec private transfer test.
 *
 * Purpose:
 *   Isolate `Token.transfer(to, amount)` from the app and run it as a plain
 *   script. This tells us whether private transfers work at all for a given
 *   account configuration.
 *
 * Usage (from frontend/):
 *   npx tsx scripts/test-private-transfer.ts <target-aztec-address> [amount]
 *
 * Examples:
 *   npx tsx scripts/test-private-transfer.ts 0x1ae8... 0.10
 *
 * Notes:
 *   - Uses `.aztec-account` by default, which in this repo is the mock solver.
 *   - If sender private balance is too low, it will first move enough public
 *     balance to private using `transfer_to_private(sender, amount)`.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

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

const ACCOUNT_FILE = resolve(__dirname, '..', '.aztec-account');
const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL || 'https://rpc.testnet.aztec-labs.com';
const TOKEN_ADDRESS = process.env.NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS;
const TOKEN_DECIMALS = 6;

const targetAddress = process.argv[2];
const amountText = process.argv[3] || '0.10';

if (!targetAddress) {
  console.error('Usage: npx tsx scripts/test-private-transfer.ts <target-aztec-address> [amount]');
  process.exit(1);
}

if (!TOKEN_ADDRESS) {
  console.error('Error: NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS not set in .env.local');
  process.exit(1);
}

if (!existsSync(ACCOUNT_FILE)) {
  console.error('Error: .aztec-account not found. Run create-account.ts first.');
  process.exit(1);
}

function parseAmount(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  const paddedFraction = fraction.padEnd(TOKEN_DECIMALS, '0').slice(0, TOKEN_DECIMALS);
  return BigInt(whole || '0') * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(paddedFraction);
}

function fmt(amount: bigint): string {
  const whole = amount / 10n ** BigInt(TOKEN_DECIMALS);
  const fraction = (amount % 10n ** BigInt(TOKEN_DECIMALS)).toString().padStart(TOKEN_DECIMALS, '0');
  return `${whole}.${fraction.slice(0, 2)}`;
}

function log(msg: string, data?: unknown) {
  const ts = new Date().toISOString().slice(11, 23);
  if (data === undefined) {
    console.log(`[${ts}] ${msg}`);
  } else {
    console.log(`[${ts}] ${msg}`, data);
  }
}

async function main() {
  const accountData = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf-8'));
  const amount = parseAmount(amountText);

  log(`Node: ${AZTEC_NODE_URL}`);
  log(`Token: ${TOKEN_ADDRESS}`);
  log(`Sender: ${accountData.address}`);
  log(`Target: ${targetAddress}`);
  log(`Amount: ${fmt(amount)} USDC`);

  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { Fr } = await import('@aztec/aztec.js/fields');
  const { Fq } = await import('@aztec/foundation/curves/bn254');
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee/testing');
  const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
  const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');

  const wallet = await EmbeddedWallet.create(AZTEC_NODE_URL, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });

  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) },
  );
  await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
  const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);

  const secretKey = Fr.fromString(accountData.secretKey);
  const signingKey = Fq.fromString(accountData.signingKey);
  const salt = Fr.fromString(accountData.salt);
  const account = await wallet.createSchnorrAccount(secretKey, salt, signingKey, 'script-sender');
  const sender = account.address;

  const tokenAddr = AztecAddress.fromString(TOKEN_ADDRESS!);
  const recipient = AztecAddress.fromString(targetAddress);
  const node = createAztecNodeClient(AZTEC_NODE_URL);
  const tokenInstance = await node.getContract(tokenAddr);
  if (!tokenInstance) {
    throw new Error(`Token contract not found on node at ${TOKEN_ADDRESS}`);
  }
  await wallet.registerContract(tokenInstance, TokenContract.artifact);
  await wallet.registerSender(sender, 'self');
  await wallet.registerSender(recipient, 'recipient');

  const token = await TokenContract.at(tokenAddr, wallet);

  const privateBalance = BigInt(
    (
      await token.methods.balance_of_private(sender).simulate({
        from: sender,
      })
    )?.toString() || '0'
  );
  const publicBalance = BigInt(
    (
      await token.methods.balance_of_public(sender).simulate({
        from: sender,
      })
    )?.toString() || '0'
  );

  log(`Sender private balance: ${fmt(privateBalance)} USDC`);
  log(`Sender public balance: ${fmt(publicBalance)} USDC`);

  if (privateBalance < amount) {
    const required = amount - privateBalance;
    if (publicBalance < required) {
      throw new Error(
        `Insufficient balance. Need ${fmt(amount)} private USDC, have ${fmt(privateBalance)} private and ${fmt(publicBalance)} public.`,
      );
    }

    log(`Shielding ${fmt(required)} USDC from public to private first...`);
    const shieldReceipt = await token.methods
      .transfer_to_private(sender, required)
      .send({
        from: sender,
        fee: { paymentMethod },
        wait: { timeout: 300 },
      });
    log(`Shield tx: ${shieldReceipt.txHash.toString()}`);
  }

  log('Sending direct private transfer...');
  const receipt = await (token.methods as any)
    .transfer(recipient, amount)
    .send({
      from: sender,
      fee: { paymentMethod },
      wait: { timeout: 300 },
    });

  log(`Transfer tx: ${receipt.txHash.toString()}`);
  log('Private transfer succeeded.');

  await wallet.stop();
}

main().catch(err => {
  console.error('\nFailed:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
