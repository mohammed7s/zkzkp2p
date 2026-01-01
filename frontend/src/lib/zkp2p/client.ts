/**
 * zkp2p Offramp SDK Integration
 *
 * This module provides a wrapper around the @zkp2p/offramp-sdk for creating
 * deposits on the zkp2p protocol after bridging from Aztec.
 */

import {
  Zkp2pClient,
  Currency,
  getContracts,
  SUPPORTED_CHAIN_IDS,
  type CreateDepositParams,
} from '@zkp2p/offramp-sdk';
import type { WalletClient, Hash } from 'viem';

// Base Sepolia for testnet
const CHAIN_ID = SUPPORTED_CHAIN_IDS.BASE_SEPOLIA;
const RUNTIME_ENV = 'staging' as const;

// Get contract addresses
const { addresses } = getContracts(CHAIN_ID, RUNTIME_ENV);
export const USDC_ADDRESS = addresses.usdc as `0x${string}`;
export const ESCROW_ADDRESS = addresses.escrow;

// Conversion rate: 1 USDC = 1.02 fiat (2% premium)
// Rate is in 18 decimals: 1.02 * 10^18 = 1020000000000000000
const DEFAULT_CONVERSION_RATE = '1020000000000000000';

export interface CreateZkp2pDepositParams {
  walletClient: WalletClient;
  amount: bigint;
  minIntentAmount: bigint;
  maxIntentAmount: bigint;
  paymentMethod: 'revolut' | 'wise' | 'venmo';
  paymentTag: string; // revtag, email, or venmo username
  currency: 'USD' | 'EUR' | 'GBP';
  conversionRate?: string;
}

export interface CreateZkp2pDepositResult {
  hash: Hash;
}

/**
 * Create a zkp2p client instance
 */
export function createZkp2pClient(walletClient: WalletClient): Zkp2pClient {
  return new Zkp2pClient({
    walletClient,
    chainId: CHAIN_ID,
    runtimeEnv: RUNTIME_ENV,
    // API key is optional for testnet
    apiKey: process.env.NEXT_PUBLIC_ZKP2P_API_KEY,
  });
}

/**
 * Create a deposit on zkp2p
 *
 * This is called after the user has redeemed USDC on Base from the Train bridge.
 */
export async function createZkp2pDeposit(
  params: CreateZkp2pDepositParams
): Promise<CreateZkp2pDepositResult> {
  const {
    walletClient,
    amount,
    minIntentAmount,
    maxIntentAmount,
    paymentMethod,
    paymentTag,
    currency,
    conversionRate = DEFAULT_CONVERSION_RATE,
  } = params;

  const client = createZkp2pClient(walletClient);

  // Map payment method to deposit data format
  const depositData = getDepositData(paymentMethod, paymentTag);

  // Create conversion rates array (one per payment method)
  const conversionRates = [[
    { currency: currency as keyof typeof Currency, conversionRate },
  ]];

  console.log('[zkp2p] Creating deposit...', {
    token: USDC_ADDRESS,
    amount: amount.toString(),
    paymentMethod,
    currency,
  });

  const result = await client.createDeposit({
    token: USDC_ADDRESS,
    amount,
    intentAmountRange: {
      min: minIntentAmount,
      max: maxIntentAmount,
    },
    processorNames: [paymentMethod],
    depositData: [depositData],
    conversionRates,
  });

  console.log('[zkp2p] Deposit result:', result);

  return {
    hash: result.hash,
  };
}

/**
 * Get deposit data format for a payment method
 */
function getDepositData(
  paymentMethod: 'revolut' | 'wise' | 'venmo',
  paymentTag: string
): Record<string, string> {
  switch (paymentMethod) {
    case 'revolut':
      // Revolut uses revtag (e.g., @username)
      return { tag: paymentTag.startsWith('@') ? paymentTag : `@${paymentTag}` };
    case 'wise':
      // Wise uses email
      return { email: paymentTag };
    case 'venmo':
      // Venmo uses username
      return { username: paymentTag.replace('@', '') };
    default:
      return { tag: paymentTag };
  }
}

/**
 * Get user's deposits from zkp2p
 */
export async function getZkp2pDeposits(walletClient: WalletClient) {
  const client = createZkp2pClient(walletClient);

  const deposits = await client.getDeposits();
  return deposits;
}

/**
 * Format amount for display (6 decimals for USDC)
 */
export function formatUSDC(amount: bigint): string {
  const divisor = 10n ** 6n;
  const whole = amount / divisor;
  const fraction = amount % divisor;
  return `${whole}.${fraction.toString().padStart(6, '0')}`;
}

/**
 * Parse display amount to raw USDC amount (6 decimals)
 */
export function parseUSDC(displayAmount: string): bigint {
  const [whole, fraction = ''] = displayAmount.split('.');
  const paddedFraction = fraction.padEnd(6, '0').slice(0, 6);
  return BigInt(whole || '0') * 10n ** 6n + BigInt(paddedFraction);
}
