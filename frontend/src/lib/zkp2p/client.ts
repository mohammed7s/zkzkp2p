/**
 * zkp2p / Peer Offramp SDK Integration
 *
 * Uses @zkp2p/sdk (OfframpClient) for creating deposits on the zkp2p protocol.
 * This is the liquidity provider side — our burner wallet deposits USDC
 * and accepts fiat payments from takers.
 */

import {
  OfframpClient,
  SUPPORTED_CHAIN_IDS,
  getContracts,
  type CreateDepositParams,
} from '@zkp2p/sdk';
import { publicActions, type WalletClient, type Hash } from 'viem';

// Base Mainnet production
const CHAIN_ID = SUPPORTED_CHAIN_IDS.BASE_MAINNET;

// Get contract addresses
const { addresses } = getContracts(CHAIN_ID);
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
  paymentTag: string;
  currency: 'USD' | 'EUR' | 'GBP';
  conversionRate?: string;
}

export interface CreateZkp2pDepositResult {
  hash: Hash;
}

/**
 * Map payment method + tag to the correct depositData format.
 * Each payment processor expects a specific key.
 */
function getDepositData(
  paymentMethod: 'revolut' | 'wise' | 'venmo',
  paymentTag: string
): Record<string, string> {
  switch (paymentMethod) {
    case 'revolut':
      return { revolutUsername: paymentTag.replace(/^@/, '') };
    case 'wise':
      return { wisetag: paymentTag.replace(/^@/, '') };
    case 'venmo':
      return { venmoUsername: paymentTag.replace(/^@/, '') };
    default:
      return { tag: paymentTag };
  }
}

/**
 * Create a zkp2p client instance
 */
export function createZkp2pClient(walletClient: WalletClient): OfframpClient {
  return new OfframpClient({
    walletClient,
    chainId: CHAIN_ID,
  });
}

/**
 * Create a deposit on zkp2p.
 * Called after the burner has received USDC on Base from the solver.
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
  const receiptClient = walletClient.extend(publicActions);

  const depositData = getDepositData(paymentMethod, paymentTag);

  const conversionRates = [[
    { currency, conversionRate },
  ]];

  console.log('[zkp2p] Creating deposit...', {
    token: USDC_ADDRESS,
    amount: amount.toString(),
    paymentMethod,
    depositData,
    currency,
  });

  // Ensure USDC is approved for the escrow contract
  console.log('[zkp2p] Ensuring USDC allowance...');
  const allowanceResult = await client.ensureAllowance({
    token: USDC_ADDRESS,
    amount,
    spender: ESCROW_ADDRESS,
  });
  if (!allowanceResult.hadAllowance && allowanceResult.hash) {
    console.log('[zkp2p] Approval tx hash:', allowanceResult.hash);
    await receiptClient.waitForTransactionReceipt({ hash: allowanceResult.hash as Hash });
  }
  console.log('[zkp2p] Allowance OK');

  const result = await client.createDeposit({
    token: USDC_ADDRESS,
    amount,
    intentAmountRange: {
      min: minIntentAmount,
      max: maxIntentAmount,
    },
    processorNames: [paymentMethod],
    depositData: [{ ...depositData, offchainId: Object.values(depositData)[0] }] as any,
    conversionRates,
  });

  console.log('[zkp2p] Deposit result:', result);

  return {
    hash: (result as any)?.hash || '0x',
  };
}

/**
 * Get all deposits for the connected wallet
 */
export async function getZkp2pDeposits(walletClient: WalletClient) {
  const client = createZkp2pClient(walletClient);
  return client.getDeposits();
}

/**
 * Get deposits by owner address
 */
export async function getZkp2pAccountDeposits(walletClient: WalletClient, owner: `0x${string}`) {
  const client = createZkp2pClient(walletClient);
  return client.getAccountDeposits(owner);
}

/**
 * Get a specific deposit by ID
 */
export async function getZkp2pDeposit(walletClient: WalletClient, depositId: bigint) {
  const client = createZkp2pClient(walletClient);
  return client.getDeposit(depositId);
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
