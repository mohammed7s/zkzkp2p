/**
 * NEAR Intents Bridge Layer
 *
 * Production: NEAR 1Click API (https://1click.chaindefuser.com/v0/)
 * Pre-alpha mock flow:
 *   1. User sends Aztec private USDC to solver's Aztec address (real tx)
 *   2. Solver (you) manually sends Base USDC to the burner smart account
 *   3. App polls for USDC arrival on burner, then continues to zkp2p
 *
 * Once NEAR Intents supports Aztec, replace with:
 *   1. GET /v0/tokens → find assetIds for Aztec USDC + Base USDC
 *   2. POST /v0/quote (dry: false) → get depositAddress on Aztec (~10min valid)
 *   3. aztecWallet sends to depositAddress on Aztec
 *   4. POST /v0/deposit/submit → notify solver with txHash
 *   5. GET /v0/status?depositAddress=... → poll until SUCCESS
 *   The recipient (our burner on Base) receives USDC automatically.
 */

import { type PublicClient, type Hex, erc20Abi } from 'viem';
import { CONTRACTS } from '@/config';

// ============================================================================
// NEAR 1Click API Types
// ============================================================================

const API_BASE = 'https://1click.chaindefuser.com';

export interface NearToken {
  assetId: string;
  decimals: number;
  blockchain: string; // 'eth', 'base', 'near', 'arb', etc.
  symbol: string;
  price: string;
  priceUpdatedAt: string;
  contractAddress?: string;
}

export interface NearQuoteRequest {
  dry: boolean;
  swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT' | 'ANY_INPUT';
  originAsset: string;       // assetId from GET /v0/tokens
  destinationAsset: string;  // assetId from GET /v0/tokens
  amount: string;            // smallest unit (wei/lamports)
  recipient: string;         // address on destination chain to receive output
  refundTo: string;          // address on origin chain for refunds
  slippageTolerance?: number; // basis points, 100 = 1%
  depositType?: 'ORIGIN_CHAIN' | 'INTENTS';
  recipientType?: 'DESTINATION_CHAIN' | 'INTENTS';
  refundType?: 'ORIGIN_CHAIN' | 'INTENTS';
  depositMode?: 'SIMPLE' | 'MEMO';
  deadline?: string;         // ISO timestamp
  quoteWaitingTimeMs?: number;
  referral?: string;
  appFees?: Array<{ recipient: string; fee: number }>;
}

export interface NearQuoteResponse {
  correlationId: string;
  timestamp: string;
  quote: {
    depositAddress: string;     // send tokens HERE on origin chain
    depositMemo: string | null; // include in tx if non-null (Stellar)
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;       // display only, never use in logic
    minAmountIn?: string;
    maxAmountIn?: string;
    minAmountOut?: string;
    deadline: string;           // deposit must arrive before this
    timeWhenInactive: string;
    timeEstimate: number;       // expected completion seconds
  };
}

export type NearSwapStatus =
  | 'PENDING_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'INCOMPLETE_DEPOSIT'
  | 'REFUNDED'
  | 'FAILED';

export const TERMINAL_STATUSES: NearSwapStatus[] = [
  'SUCCESS', 'FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT',
];

export interface NearStatusResponse {
  correlationId: string;
  status: NearSwapStatus;
  updatedAt: string;
  swapDetails?: {
    amountIn: string;
    amountInFormatted: string;
    amountOut: string;
    amountOutFormatted: string;
    slippage: number;
    originChainTxHashes: Array<{ hash: string; explorerUrl: string }>;
    destinationChainTxHashes: Array<{ hash: string; explorerUrl: string }>;
    refundedAmount?: string;
    refundReason?: string;
    depositedAmount?: string;
  };
}

// ============================================================================
// Real API functions (ready for when Aztec connector ships)
// ============================================================================

export async function fetchTokens(apiKey?: string): Promise<NearToken[]> {
  const res = await fetch(`${API_BASE}/v0/tokens`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`Failed to fetch tokens: ${res.status}`);
  return res.json();
}

export function findToken(tokens: NearToken[], symbol: string, blockchain: string): NearToken | undefined {
  return tokens.find(
    t => t.symbol.toLowerCase() === symbol.toLowerCase() && t.blockchain === blockchain,
  );
}

export async function getQuote(params: NearQuoteRequest, apiKey?: string): Promise<NearQuoteResponse> {
  const res = await fetch(`${API_BASE}/v0/quote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Quote failed: ${error}`);
  }
  return res.json();
}

export async function submitDeposit(txHash: string, depositAddress: string, apiKey?: string): Promise<void> {
  await fetch(`${API_BASE}/v0/deposit/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({ txHash, depositAddress }),
  });
}

export async function pollStatus(depositAddress: string, apiKey?: string): Promise<NearStatusResponse> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  for (let i = 0; i < 180; i++) {
    const res = await fetch(
      `${API_BASE}/v0/status?depositAddress=${depositAddress}`,
      { headers },
    );
    const status: NearStatusResponse = await res.json();

    if (TERMINAL_STATUSES.includes(status.status)) {
      return status;
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  throw new Error('Timeout waiting for swap completion');
}

// ============================================================================
// Pre-alpha: send Aztec USDC to solver (real Aztec private transfer)
// ============================================================================

export interface SolverConfig {
  aztecAddress: string; // Solver's Aztec address (receives private USDC)
  tokenAddress: string; // Aztec token contract address
}

export function getSolverConfig(): SolverConfig {
  const aztecAddress = process.env.NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS || '';
  const tokenAddress = CONTRACTS.aztec.token;
  return { aztecAddress, tokenAddress };
}

export function isSolverConfigured(): boolean {
  const { aztecAddress, tokenAddress } = getSolverConfig();
  return !!(aztecAddress && tokenAddress);
}

/**
 * Send private USDC on Aztec to the solver address.
 * This is the "Aztec side" of the mock bridge — the solver sees
 * this transfer and manually sends Base USDC to the burner.
 *
 * Uses the standard Token contract `transfer(from, to, amount, nonce)`.
 */
export async function sendToSolver(params: {
  aztecWallet: any;     // EmbeddedWallet (Wallet interface)
  senderAddress: string;
  amount: bigint;
}): Promise<string> {
  const { aztecWallet, senderAddress, amount } = params;
  const { aztecAddress: solverAddress, tokenAddress } = getSolverConfig();

  if (!solverAddress || !tokenAddress) {
    throw new Error('Solver not configured — set NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS and NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS');
  }

  console.log('[NearIntents/Mock] Sending', amount.toString(), 'private USDC to solver:', solverAddress);

  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const { Contract } = await import('@aztec/aztec.js/contracts');

  const tokenAddr = AztecAddress.fromString(tokenAddress);
  const fromAddr = AztecAddress.fromString(senderAddress);
  const toAddr = AztecAddress.fromString(solverAddress);

  const tokenContract = await Contract.at(tokenAddr, [] as any, aztecWallet);
  const tx = await (tokenContract.methods as any)
    .transfer(fromAddr, toAddr, amount, 0n)
    .send()
    .wait();

  const txHash = tx.txHash.toString();
  console.log('[NearIntents/Mock] Aztec transfer confirmed:', txHash);
  return txHash;
}

// ============================================================================
// Pre-alpha: poll for USDC balance on burner (the "recipient" in
// the real NEAR Intents flow). Simulates the solver filling the order.
// ============================================================================

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const POLL_INTERVAL_MS = 5000;

export interface MockBridgeCallbacks {
  onWaitingForFunds: (burnerAddress: string) => void;
  onFundsReceived: (balance: bigint) => void;
}

/**
 * Mock bridge: wait for USDC to arrive at the burner smart account.
 *
 * In production, NEAR Intents delivers USDC to this address (the `recipient`
 * param in the quote). For pre-alpha, send USDC here manually from any wallet.
 */
export async function waitForBridgedFunds(params: {
  publicClient: PublicClient;
  burnerAddress: Hex;
  expectedAmount: bigint;
  callbacks?: MockBridgeCallbacks;
  abortSignal?: AbortSignal;
}): Promise<bigint> {
  const { publicClient, burnerAddress, expectedAmount, callbacks, abortSignal } = params;

  callbacks?.onWaitingForFunds(burnerAddress);
  console.log('[NearIntents/Mock] Waiting for USDC on:', burnerAddress);
  console.log('[NearIntents/Mock] Expected amount:', expectedAmount.toString());
  console.log('[NearIntents/Mock] Send USDC manually to this address to continue');

  return new Promise<bigint>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    const onAbort = () => {
      cleanup();
      reject(new Error('Bridge cancelled'));
    };

    if (abortSignal) {
      if (abortSignal.aborted) { reject(new Error('Bridge cancelled')); return; }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const poll = async () => {
      if (abortSignal?.aborted) return;

      try {
        const balance = await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [burnerAddress],
        });

        if (balance > 0n) {
          console.log('[NearIntents/Mock] Funds received:', balance.toString());
          cleanup();
          abortSignal?.removeEventListener('abort', onAbort);
          callbacks?.onFundsReceived(balance);
          resolve(balance);
          return;
        }
      } catch (e) {
        console.warn('[NearIntents/Mock] Balance check failed:', e);
      }

      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();
  });
}

/**
 * Check if bridge is configured.
 * Mock requires solver Aztec address + token address.
 * Real impl would check for NEAR Intents API key.
 */
export function isBridgeConfigured(): boolean {
  return isSolverConfigured();
}

// ============================================================================
// High-level bridge function — THIS IS WHAT GETS SWAPPED FOR NEAR INTENTS
//
// When NEAR Intents supports Aztec, replace the body of executeBridge() with:
//   1. const tokens = await fetchTokens(apiKey);
//   2. const aztecUsdc = findToken(tokens, 'USDC', 'aztec');
//   3. const baseUsdc = findToken(tokens, 'USDC', 'base');
//   4. const quote = await getQuote({ dry: false, swapType: 'EXACT_INPUT',
//        originAsset: aztecUsdc.assetId, destinationAsset: baseUsdc.assetId,
//        amount: params.amount.toString(), recipient: params.baseRecipient,
//        refundTo: params.aztecSender }, apiKey);
//   5. Send Aztec tokens to quote.quote.depositAddress
//   6. await submitDeposit(txHash, quote.quote.depositAddress, apiKey);
//   7. await pollStatus(quote.quote.depositAddress, apiKey);
//   8. return receivedBalance on baseRecipient
// ============================================================================

export interface BridgeCallbacks {
  onSendingToSolver: () => void;     // mock: sending Aztec tx to solver
  onSolverTxConfirmed: (txHash: string) => void;
  onWaitingForFunds: (burnerAddress: string) => void;
  onFundsReceived: (balance: bigint) => void;
}

/**
 * Execute the full Aztec → Base bridge.
 *
 * Mock: sends Aztec USDC to solver, then polls for Base USDC on burner.
 * Production: will call NEAR 1Click API instead.
 *
 * Returns the USDC balance received on the burner.
 */
export async function executeBridge(params: {
  // Aztec side
  aztecWallet: any;
  aztecSender: string;
  amount: bigint;
  // Base side (recipient = burner smart account)
  baseRecipient: Hex;
  publicClient: PublicClient;
  // Control
  callbacks?: BridgeCallbacks;
  abortSignal?: AbortSignal;
}): Promise<{ receivedAmount: bigint; aztecTxHash: string }> {
  const {
    aztecWallet, aztecSender, amount,
    baseRecipient, publicClient,
    callbacks, abortSignal,
  } = params;

  // Step 1: Send Aztec private USDC to solver
  callbacks?.onSendingToSolver();
  const aztecTxHash = await sendToSolver({
    aztecWallet,
    senderAddress: aztecSender,
    amount,
  });
  callbacks?.onSolverTxConfirmed(aztecTxHash);

  // Step 2: Wait for solver to send Base USDC to burner
  const receivedAmount = await waitForBridgedFunds({
    publicClient,
    burnerAddress: baseRecipient,
    expectedAmount: amount,
    abortSignal,
    callbacks: callbacks ? {
      onWaitingForFunds: callbacks.onWaitingForFunds,
      onFundsReceived: callbacks.onFundsReceived,
    } : undefined,
  });

  return { receivedAmount, aztecTxHash };
}

// ============================================================================
// Helpers (shared between mock and real)
// ============================================================================

export function formatTokenAmount(amount: bigint, decimals: number = 6): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 2);
  return `${whole}.${fractionStr}`;
}

export function parseTokenAmount(amount: string, decimals: number = 6): bigint {
  const [whole, fraction = ''] = amount.split('.');
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole || '0') * BigInt(10 ** decimals) + BigInt(paddedFraction);
}
