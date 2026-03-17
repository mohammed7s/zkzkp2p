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

import { type PublicClient, type Hex, erc20Abi, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { CONTRACTS, CHAINS } from '@/config';

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

interface SolverAztecAccountConfig {
  address: string;
  secretKey: string;
  signingKey: string;
  salt: string;
}

export function getSolverConfig(): SolverConfig {
  const aztecAddress = import.meta.env.NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS || '';
  const tokenAddress = CONTRACTS.aztec.token;
  return { aztecAddress, tokenAddress };
}

function getSolverAztecAccountConfig(): SolverAztecAccountConfig | null {
  const address = import.meta.env.NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS || '';
  const secretKey = import.meta.env.NEXT_PUBLIC_SOLVER_AZTEC_SECRET_KEY || '';
  const signingKey = import.meta.env.NEXT_PUBLIC_SOLVER_AZTEC_SIGNING_KEY || '';
  const salt = import.meta.env.NEXT_PUBLIC_SOLVER_AZTEC_SALT || '';

  if (!address || !secretKey || !signingKey || !salt) {
    return null;
  }

  return { address, secretKey, signingKey, salt };
}

export function isSolverConfigured(): boolean {
  const { aztecAddress, tokenAddress } = getSolverConfig();
  return !!(aztecAddress && tokenAddress && CONTRACTS.base.token);
}

/**
 * Send private USDC on Aztec to the solver address.
 * This is the "Aztec side" of the mock bridge — the solver sees
 * this transfer and manually sends Base USDC to the burner.
 *
 * Uses the standard private `transfer(to, amount)` flow.
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

  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const tokenAddr = AztecAddress.fromString(tokenAddress);
  const fromAddr = AztecAddress.fromString(senderAddress);
  const toAddr = AztecAddress.fromString(solverAddress);

  const tokenContract = await TokenContract.at(tokenAddr, aztecWallet);
  const sentTx = await (tokenContract.methods as any)
    .transfer(toAddr, amount)
    .send({ from: fromAddr });
  const receipt = await sentTx.wait();

  const txHash = receipt.txHash?.toString() || sentTx.txHash?.toString() || 'unknown';
  console.log('[NearIntents/Mock] Aztec transfer confirmed:', txHash);
  return txHash;
}

// ============================================================================
// Pre-alpha: auto-send Base USDC from solver wallet to burner
// Simulates the solver filling the order after Aztec tx confirms.
// ============================================================================

const POLL_INTERVAL_MS = 5000;
let cachedSolverAztecWallet:
  | Promise<{
      wallet: any;
      account: any;
      paymentMethod: any;
      token: any;
    }>
  | null = null;

function getBaseTokenAddress(): Hex {
  const baseToken = CONTRACTS.base.token as Hex | undefined;
  if (!baseToken) {
    throw new Error('NEXT_PUBLIC_BASE_TOKEN_ADDRESS not set');
  }
  return baseToken;
}

/**
 * Get the solver's Base wallet from env.
 * This wallet must be pre-funded with Base USDC.
 */
function getSolverBaseWallet() {
  const privateKey = import.meta.env.NEXT_PUBLIC_SOLVER_BASE_PRIVATE_KEY as Hex | undefined;
  if (!privateKey) return null;
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(import.meta.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org'),
  });
  return { wallet, account };
}

export function getSolverBaseAddress(): Hex | null {
  return getSolverBaseWallet()?.account.address ?? null;
}

export function isBaseFaucetAvailable(): boolean {
  return !!getSolverBaseWallet() && !!CONTRACTS.base.token;
}

async function getSolverAztecWallet() {
  if (cachedSolverAztecWallet) {
    return cachedSolverAztecWallet;
  }

  cachedSolverAztecWallet = (async () => {
    const solver = getSolverAztecAccountConfig();
    if (!solver) {
      throw new Error(
        'Solver Aztec account not configured. ' +
        'Set NEXT_PUBLIC_SOLVER_AZTEC_SECRET_KEY, NEXT_PUBLIC_SOLVER_AZTEC_SIGNING_KEY, and NEXT_PUBLIC_SOLVER_AZTEC_SALT.'
      );
    }

    const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
    const { Fr, GrumpkinScalar } = await import('@aztec/aztec.js/fields');
    const { AztecAddress } = await import('@aztec/aztec.js/addresses');
    const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
    const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
    const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee/testing');
    const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');
    const { BarretenbergSync } = await import('@aztec/bb.js');

    await BarretenbergSync.initSingleton({
      logger: (msg: string) => console.log('[MockSolver/bb.js]', msg),
    });

    const wallet = await EmbeddedWallet.create(CHAINS.aztec.nodeUrl, {
      ephemeral: true,
      pxeConfig: { proverEnabled: true },
    });

    const account = await wallet.createSchnorrAccount(
      Fr.fromString(solver.secretKey),
      Fr.fromString(solver.salt),
      (GrumpkinScalar as any).fromString(solver.signingKey),
      'mock-solver',
    );

    if (account.address.toString().toLowerCase() !== solver.address.toLowerCase()) {
      throw new Error(
        `Configured solver Aztec address ${solver.address} does not match derived account ${account.address.toString()}`
      );
    }

    const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContract.artifact,
      { salt: new Fr(0) },
    );
    await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
    const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);

    const tokenAddr = AztecAddress.fromString(CONTRACTS.aztec.token);
    const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
    const nodeClient = createAztecNodeClient(CHAINS.aztec.nodeUrl);
    const tokenInstance = await (nodeClient as any).getContract(tokenAddr);
    if (tokenInstance) {
      await wallet.registerContract(tokenInstance, TokenContract.artifact);
    }

    const token = await TokenContract.at(tokenAddr, wallet);

    return { wallet, account, paymentMethod, token };
  })();

  try {
    return await cachedSolverAztecWallet;
  } catch (err) {
    cachedSolverAztecWallet = null;
    throw err;
  }
}

async function ensureSolverPrivateBalance(amount: bigint): Promise<void> {
  const { account, paymentMethod, token } = await getSolverAztecWallet();

  const privateBalance = BigInt(
    (
      await token.methods.balance_of_private(account.address).simulate({
        from: account.address,
      })
    )?.toString() || '0'
  );

  if (privateBalance >= amount) {
    return;
  }

  const required = amount - privateBalance;
  const publicBalance = BigInt(
    (
      await token.methods.balance_of_public(account.address).simulate({
        from: account.address,
      })
    )?.toString() || '0'
  );

  if (publicBalance < required) {
    throw new Error(
      `Solver Aztec wallet has ${privateBalance} private and ${publicBalance} public USDC, needs ${amount}.`
    );
  }

  console.log('[MockSolver] Shielding solver public balance on Aztec:', required.toString());
  await token.methods
    .transfer_to_private(account.address, required)
    .send({
      from: account.address,
      fee: { paymentMethod },
      wait: { timeout: 300 },
    });
}

async function solverSendAztecUSDC(params: {
  recipientAddress: string;
  amount: bigint;
}): Promise<string> {
  const { recipientAddress, amount } = params;
  const { account, paymentMethod, token } = await getSolverAztecWallet();
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');

  const recipient = AztecAddress.fromString(recipientAddress);
  const publicBalance = BigInt(
    (
      await token.methods.balance_of_public(account.address).simulate({
        from: account.address,
      })
    )?.toString() || '0'
  );

  let receipt: any;

  if (publicBalance >= amount) {
    console.log('[MockSolver] Sending public -> private fill on Aztec:', amount.toString());
    receipt = await token.methods
      .transfer_to_private(recipient, amount)
      .send({
        from: account.address,
        fee: { paymentMethod },
        wait: { timeout: 300 },
      });
  } else {
    await ensureSolverPrivateBalance(amount);
    receipt = await (token.methods as any)
      .transfer(recipient, amount)
      .send({
        from: account.address,
        fee: { paymentMethod },
        wait: { timeout: 300 },
      });
  }

  const txHash = receipt?.txHash?.toString?.() || receipt?.toString?.() || 'unknown';
  console.log('[MockSolver] Aztec private fill sent:', txHash);
  return txHash;
}

export async function sendBaseToSolver(params: {
  walletClient: any;
  publicClient: PublicClient;
  senderAddress: Hex;
  amount: bigint;
}): Promise<string> {
  const { walletClient, publicClient, senderAddress, amount } = params;
  const solver = getSolverBaseWallet();
  if (!solver) {
    throw new Error(
      'NEXT_PUBLIC_SOLVER_BASE_PRIVATE_KEY not set. ' +
      'Cannot derive solver Base address for the mock bridge.'
    );
  }

  const baseToken = getBaseTokenAddress();
  const { request } = await publicClient.simulateContract({
    address: baseToken,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [solver.account.address, amount],
    account: senderAddress,
  });

  const txHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log('[MockSolver] User sent Base USDC to solver:', txHash);
  return txHash;
}

/**
 * Mock solver: send Base USDC from the pre-funded solver wallet to the burner.
 * This replaces the manual step — the app acts as its own solver.
 */
async function solverSendBaseUSDC(params: {
  burnerAddress: Hex;
  amount: bigint;
  publicClient: PublicClient;
}): Promise<Hex> {
  const { burnerAddress, amount, publicClient } = params;
  const solver = getSolverBaseWallet();

  if (!solver) {
    throw new Error(
      'NEXT_PUBLIC_SOLVER_BASE_PRIVATE_KEY not set. ' +
      'Add a pre-funded Base wallet private key to .env.local'
    );
  }

  console.log('[MockSolver] Sending', amount.toString(), 'USDC to burner:', burnerAddress);
  console.log('[MockSolver] From solver wallet:', solver.account.address);

  // Check solver has enough USDC
  const solverBalance = await publicClient.readContract({
    address: getBaseTokenAddress(),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [solver.account.address],
  });
  console.log('[MockSolver] Solver USDC balance:', solverBalance.toString());

  if (solverBalance < amount) {
    throw new Error(
      `Solver wallet has ${solverBalance} USDC but needs ${amount}. ` +
      `Fund ${solver.account.address} with Base USDC.`
    );
  }

  // Send USDC to burner
  const txHash = await solver.wallet.writeContract({
    address: getBaseTokenAddress(),
    abi: erc20Abi,
    functionName: 'transfer',
    args: [burnerAddress, amount],
  });

  console.log('[MockSolver] Base USDC tx sent:', txHash);

  // Wait for confirmation
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log('[MockSolver] Confirmed in block:', receipt.blockNumber);

  return txHash;
}

export async function fundBaseAddressFromSolver(params: {
  recipientAddress: Hex;
  amount: bigint;
  publicClient: PublicClient;
}): Promise<string> {
  const { recipientAddress, amount, publicClient } = params;
  return solverSendBaseUSDC({
    burnerAddress: recipientAddress,
    amount,
    publicClient,
  });
}

/**
 * Send Base USDC to burner, then poll until balance appears.
 * Falls back to manual wait if solver wallet is not configured.
 */
export async function waitForBridgedFunds(params: {
  publicClient: PublicClient;
  burnerAddress: Hex;
  expectedAmount: bigint;
  callbacks?: {
    onWaitingForFunds: (burnerAddress: string) => void;
    onFundsSentTx?: (txHash: string) => void;
    onFundsReceived: (balance: bigint) => void;
  };
  abortSignal?: AbortSignal;
}): Promise<bigint> {
  const { publicClient, burnerAddress, expectedAmount, callbacks, abortSignal } = params;

  // Try auto-send from solver wallet
  const solver = getSolverBaseWallet();
  if (solver) {
    callbacks?.onWaitingForFunds(burnerAddress);
    try {
      const txHash = await solverSendBaseUSDC({ burnerAddress, amount: expectedAmount, publicClient });
      callbacks?.onFundsSentTx?.(txHash);
    } catch (e: any) {
      console.error('[MockSolver] Auto-send failed:', e.message);
      console.log('[MockSolver] Falling back to manual mode — send USDC to:', burnerAddress);
    }
  } else {
    callbacks?.onWaitingForFunds(burnerAddress);
    console.log('[NearIntents/Mock] No solver wallet configured. Send USDC manually to:', burnerAddress);
  }

  // Poll for balance (covers both auto-send confirmation and manual fallback)
  return new Promise<bigint>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => { if (timer) clearTimeout(timer); };
    const onAbort = () => { cleanup(); reject(new Error('Bridge cancelled')); };

    if (abortSignal) {
      if (abortSignal.aborted) { reject(new Error('Bridge cancelled')); return; }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const poll = async () => {
      if (abortSignal?.aborted) return;
      try {
        const balance = await publicClient.readContract({
          address: getBaseTokenAddress(),
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [burnerAddress],
        });
        if (balance > 0n) {
          console.log('[NearIntents/Mock] Funds on burner:', balance.toString());
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
 * Solver Base key is optional (falls back to manual mode without it).
 * Real impl would check for NEAR Intents API key.
 */
export function isBridgeConfigured(): boolean {
  return isSolverConfigured();
}

export function isSolverAutoSendEnabled(): boolean {
  return !!import.meta.env.NEXT_PUBLIC_SOLVER_BASE_PRIVATE_KEY;
}

export function isBaseToAztecBridgeConfigured(): boolean {
  return !!(
    CONTRACTS.base.token &&
    getSolverBaseWallet() &&
    getSolverAztecAccountConfig()
  );
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
  onFundsSentTx?: (txHash: string) => void;
  onFundsReceived: (balance: bigint) => void;
}

export interface BaseToAztecCallbacks {
  onSendingToSolver: () => void;
  onBaseTxConfirmed: (txHash: string) => void;
  onWaitingForFill: (recipientAddress: string) => void;
  onAztecTxConfirmed: (txHash: string) => void;
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
      onFundsSentTx: callbacks.onFundsSentTx,
      onFundsReceived: callbacks.onFundsReceived,
    } : undefined,
  });

  return { receivedAmount, aztecTxHash };
}

export async function executeBaseToAztecBridge(params: {
  walletClient: any;
  publicClient: PublicClient;
  evmSender: Hex;
  aztecRecipient: string;
  amount: bigint;
  callbacks?: BaseToAztecCallbacks;
}): Promise<{ baseTxHash: string; aztecTxHash: string }> {
  const {
    walletClient,
    publicClient,
    evmSender,
    aztecRecipient,
    amount,
    callbacks,
  } = params;

  callbacks?.onSendingToSolver();
  const baseTxHash = await sendBaseToSolver({
    walletClient,
    publicClient,
    senderAddress: evmSender,
    amount,
  });
  callbacks?.onBaseTxConfirmed(baseTxHash);

  callbacks?.onWaitingForFill(aztecRecipient);
  const aztecTxHash = await solverSendAztecUSDC({
    recipientAddress: aztecRecipient,
    amount,
  });
  callbacks?.onAztecTxConfirmed(aztecTxHash);

  return { baseTxHash, aztecTxHash };
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
