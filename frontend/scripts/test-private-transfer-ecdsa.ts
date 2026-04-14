#!/usr/bin/env tsx
/**
 * Direct Aztec private transfer test using the app's ECDSA-K account model.
 *
 * Purpose:
 *   Reproduce the exact browser/app sender path outside React. This lets us
 *   answer whether the MetaMask-derived ECDSA-K Aztec account can send a
 *   private token transfer at all.
 *
 * Usage (from frontend/):
 *   1. From the browser console on the app page, extract cached keys:
 *      JSON.parse(sessionStorage.getItem('zkzkp2p-aztec-keys') || 'null')
 *
 *   2. Run:
 *      EVM_ADDRESS=0x... \
 *      AZTEC_SECRET_KEY=0x... \
 *      AZTEC_SALT=0x... \
 *      AZTEC_SIGNING_KEY=0x... \
 *      npx tsx scripts/test-private-transfer-ecdsa.ts <target-aztec-address> [amount]
 *
 * Optional:
 *   Instead of providing raw Aztec keys, you can provide:
 *      EVM_ADDRESS=0x...
 *      AZTEC_SIGNATURE=0x...
 *   and the script will derive the same secret/salt/signingKey as the app.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { encodePacked, keccak256, type Hex } from 'viem';

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

const AZTEC_NODE_URL = process.env.NEXT_PUBLIC_AZTEC_NODE_URL || 'https://rpc.testnet.aztec-labs.com';
const TOKEN_ADDRESS = process.env.NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS as Hex | undefined;
const TOKEN_DECIMALS = 6;
const DOMAIN = 'zkzkp2p-aztec';

const targetAddress = process.argv[2];
const amountText = process.argv[3] || '0.01';

if (!targetAddress) {
  console.error('Usage: npx tsx scripts/test-private-transfer-ecdsa.ts <target-aztec-address> [amount]');
  process.exit(1);
}

if (!TOKEN_ADDRESS) {
  console.error('Error: NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS not set in .env.local');
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

function deriveSaltRaw(address: Hex, FrCtor: any) {
  const hash = keccak256(encodePacked(['string', 'address'], [`${DOMAIN}-salt`, address]));
  return FrCtor.fromBufferReduce(Buffer.from(hash.slice(2), 'hex'));
}

function deriveAztecSecretRaw(signature: Hex, FrCtor: any) {
  const hash = keccak256(encodePacked(['string', 'bytes'], [DOMAIN, signature]));
  return FrCtor.fromBufferReduce(Buffer.from(hash.slice(2), 'hex'));
}

function deriveEcdsaSigningKey(secret: any): Buffer {
  const hex = secret.toString().replace('0x', '').padStart(64, '0').slice(-64);
  return Buffer.from(hex, 'hex');
}

async function resolveAccountMaterial() {
  const { Fr } = await import('@aztec/aztec.js/fields');

  const envSecret = process.env.AZTEC_SECRET_KEY as Hex | undefined;
  const envSalt = process.env.AZTEC_SALT as Hex | undefined;
  const envSigningKey = process.env.AZTEC_SIGNING_KEY as Hex | undefined;
  const evmAddress = process.env.EVM_ADDRESS as Hex | undefined;
  const signature = process.env.AZTEC_SIGNATURE as Hex | undefined;

  if (envSecret && envSalt && envSigningKey) {
    return {
      secret: Fr.fromString(envSecret),
      salt: Fr.fromString(envSalt),
      signingKey: Buffer.from(envSigningKey.replace('0x', ''), 'hex'),
      source: 'explicit env',
      evmAddress,
    };
  }

  if (!evmAddress || !signature) {
    throw new Error(
      'Provide either AZTEC_SECRET_KEY/AZTEC_SALT/AZTEC_SIGNING_KEY or EVM_ADDRESS/AZTEC_SIGNATURE.',
    );
  }

  const secret = deriveAztecSecretRaw(signature, Fr);
  const salt = deriveSaltRaw(evmAddress, Fr);
  const signingKey = deriveEcdsaSigningKey(secret);

  return {
    secret,
    salt,
    signingKey,
    source: 'derived from EVM_ADDRESS + AZTEC_SIGNATURE',
    evmAddress,
  };
}

async function main() {
  const amount = parseAmount(amountText);
  const { secret, salt, signingKey, source, evmAddress } = await resolveAccountMaterial();

  log(`Node: ${AZTEC_NODE_URL}`);
  log(`Token: ${TOKEN_ADDRESS}`);
  if (evmAddress) log(`EVM address: ${evmAddress}`);
  log(`Account material: ${source}`);
  log(`Target: ${targetAddress}`);
  log(`Amount: ${fmt(amount)} USDC`);

  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { Fr } = await import('@aztec/aztec.js/fields');
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

  log('Creating ECDSA-K account...');
  const account = await wallet.createECDSAKAccount(secret, salt, signingKey, 'script-ecdsa');
  const sender = account.address;
  log(`Sender Aztec address: ${sender.toString()}`);

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

  log('Checking account deployment state...');
  const deployed = await node.getContract(sender);
  log(`Account deployed: ${deployed ? 'yes' : 'no'}`);

  if (!deployed) {
    log('Attempting account deploy...');
    const deployMethod = await account.getDeployMethod();
    try {
      const deployTx = await deployMethod.send({
        from: AztecAddress.ZERO,
        fee: { paymentMethod },
        wait: { timeout: 300 },
      });
      log(`Deploy tx: ${deployTx.txHash?.toString?.() || deployTx.toString?.() || String(deployTx)}`);
    } catch (error: any) {
      log(`Deploy failed: ${error?.message || error}`);
    }
  }

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

  log('Sending direct private transfer...');
  const receipt = await (token.methods as any)
    .transfer(recipient, amount)
    .send({
      from: sender,
      fee: { paymentMethod },
      wait: { timeout: 300 },
    });

  log(`Transfer tx: ${receipt.txHash.toString()}`);
  log('ECDSA private transfer succeeded.');
  await wallet.stop();
}

main().catch(err => {
  console.error('\nFailed:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
