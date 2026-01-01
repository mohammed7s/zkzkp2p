/**
 * Deposit Flow: Aztec → Base → zkp2p
 *
 * Flow:
 * 1. User generates secret & hashlock
 * 2. User sets authwit (allow Train to transfer tokens)
 * 3. User calls lock_src on Aztec
 * 4. Solver monitors and locks on Base
 * 5. User redeems on Base (reveals secret)
 * 6. User creates zkp2p deposit
 * 7. Solver redeems on Aztec
 */

import type { AzguardClient } from '@azguardwallet/client';
import { generateSecretAndHashlock, generateSwapId, hashlockToBytes32, secretToUint256 } from '../crypto';
import {
  AZTEC_TRAIN_ADDRESS,
  AZTEC_TOKEN_ADDRESS,
  AZTEC_TRAIN_METHODS,
  AZTEC_TOKEN_METHODS,
  TOKEN_DECIMALS,
  DEFAULT_TIMELOCK_SECONDS,
  AZTEC_CHAIN_ID,
  AZTEC_VERSION,
} from './contracts';
import { executeAzguardCall, simulateAzguardView } from '../aztec/azguardHelpers';

// Authwit hash computation uses @zkpassport/poseidon2 - a lightweight
// pure TypeScript implementation that works in the browser.

// ==================== CAIP HELPERS ====================

/**
 * Extract plain address from CAIP account format
 * CAIP format: "aztec:1674512022:0x..." → "0x..."
 */
function extractAddressFromCaip(caipAccount: string): string {
  const parts = caipAccount.split(':');
  return parts[parts.length - 1];
}

// ==================== TYPES ====================

export interface DepositFlowState {
  status: DepositStatus;
  swapId: string;
  amount: bigint;
  secretHigh: bigint;
  secretLow: bigint;
  hashlockHigh: bigint;
  hashlockLow: bigint;
  aztecLockTxHash?: string;
  evmLockTxHash?: string;
  evmRedeemTxHash?: string;
  zkp2pDepositId?: string;
  error?: string;
}

export type DepositStatus =
  | 'IDLE'
  | 'GENERATING_SECRET'
  | 'SETTING_AUTHWIT'
  | 'LOCKING_AZTEC'
  | 'WAITING_SOLVER'
  | 'REDEEMING_BASE'
  | 'CREATING_DEPOSIT'
  | 'COMPLETE'
  | 'ERROR';

// ==================== FLOW FUNCTIONS ====================

/**
 * Initialize a new deposit flow
 */
export async function initDepositFlow(amount: bigint): Promise<DepositFlowState> {
  const { secretHigh, secretLow, hashlockHigh, hashlockLow } = await generateSecretAndHashlock();
  const swapId = generateSwapId();

  return {
    status: 'GENERATING_SECRET',
    swapId: swapId.toString(),
    amount,
    secretHigh,
    secretLow,
    hashlockHigh,
    hashlockLow,
  };
}

/**
 * Compute authwit hash for transfer_in_public authorization
 * Returns the message hash that needs to be authorized
 *
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function computeAuthwitHash(
  caipAccount: string,
  amount: bigint,
): Promise<{ messageHash: string; selector: bigint }> {
  if (!AZTEC_TRAIN_ADDRESS || !AZTEC_TOKEN_ADDRESS) {
    throw new Error('Contract addresses not configured');
  }

  const userAddress = extractAddressFromCaip(caipAccount);

  console.log('[Deposit] Computing authwit hash...');
  console.log('[Deposit] User address:', userAddress);
  console.log('[Deposit] Token contract:', AZTEC_TOKEN_ADDRESS);
  console.log('[Deposit] Train contract:', AZTEC_TRAIN_ADDRESS);
  console.log('[Deposit] Amount:', amount.toString());
  console.log('[Deposit] Chain ID:', AZTEC_CHAIN_ID);
  console.log('[Deposit] Version:', AZTEC_VERSION);

  // Import poseidon2 hash function
  const { poseidon2Hash } = await import('@zkpassport/poseidon2');

  const userField = BigInt(userAddress);
  const tokenField = BigInt(AZTEC_TOKEN_ADDRESS);
  const trainField = BigInt(AZTEC_TRAIN_ADDRESS);

  // Function selector for transfer_in_public(AztecAddress,AztecAddress,U128,Field)
  const TRANSFER_IN_PUBLIC_SELECTOR = await computeFunctionSelector(
    'transfer_in_public(AztecAddress,AztecAddress,U128,Field)'
  );
  console.log('[Deposit] Function selector:', '0x' + TRANSFER_IN_PUBLIC_SELECTOR.toString(16));

  // Args for transfer_in_public: [from, to, amount, nonce]
  const argsHash = poseidon2Hash([userField, trainField, amount, 0n]);
  console.log('[Deposit] Args hash:', '0x' + argsHash.toString(16).padStart(64, '0'));

  // Generator indices for authwit
  const AUTHWIT_INNER = 45n;
  const AUTHWIT_OUTER = 46n;

  // Compute inner hash: H(separator, caller, selector, argsHash)
  const innerHash = poseidon2Hash([AUTHWIT_INNER, trainField, TRANSFER_IN_PUBLIC_SELECTOR, argsHash]);
  console.log('[Deposit] Inner hash:', '0x' + innerHash.toString(16).padStart(64, '0'));

  // Compute outer hash: H(separator, consumer, chainId, version, innerHash)
  const outerHash = poseidon2Hash([
    AUTHWIT_OUTER,
    tokenField,
    BigInt(AZTEC_CHAIN_ID),
    BigInt(AZTEC_VERSION),
    innerHash
  ]);

  const messageHash = '0x' + outerHash.toString(16).padStart(64, '0');
  console.log('[Deposit] Computed authwit hash:', messageHash);

  return { messageHash, selector: TRANSFER_IN_PUBLIC_SELECTOR };
}

/**
 * Step 1: Set authwit to allow Train contract to transfer tokens
 *
 * Based on the holonym bridge pattern, authwits should be included as actions
 * within the send_transaction operation, not set separately.
 *
 * This function now just logs and returns 'skip' to let lockOnAztec handle
 * the authwit as part of the transaction actions.
 *
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 * @returns 'skip' to indicate authwit will be handled in lockOnAztec
 */
export async function setAuthwit(
  client: AzguardClient,
  caipAccount: string,
  amount: bigint,
): Promise<string> {
  if (!AZTEC_TRAIN_ADDRESS || !AZTEC_TOKEN_ADDRESS) {
    throw new Error('Contract addresses not configured');
  }

  const userAddress = extractAddressFromCaip(caipAccount);

  console.log('[Deposit] Authwit will be included as action in lock_src transaction');
  console.log('[Deposit] User:', userAddress);
  console.log('[Deposit] Train (caller):', AZTEC_TRAIN_ADDRESS);
  console.log('[Deposit] Token (target):', AZTEC_TOKEN_ADDRESS);
  console.log('[Deposit] Amount:', amount.toString());

  // Following holonym bridge pattern: authwit is included as an action
  // in the send_transaction, not set separately
  return 'skip';
}

/**
 * Compute Aztec function selector from function signature
 * The selector is the last 4 bytes of poseidon2Hash(signature_bytes)
 */
async function computeFunctionSelector(signature: string): Promise<bigint> {
  const { poseidon2Hash } = await import('@zkpassport/poseidon2');

  // Convert signature string to array of field elements (one per byte)
  const bytes = new TextEncoder().encode(signature);
  const fields = Array.from(bytes).map(b => BigInt(b));

  // Hash the bytes
  const hash = poseidon2Hash(fields);

  // Take last 4 bytes (32 bits) of the 256-bit hash
  const selector = hash & 0xffffffffn;

  return selector;
}

/**
 * Step 2: Lock tokens on Aztec via lock_src
 *
 * IMPORTANT: lock_src internally calls token.transfer_in_public which requires
 * a PUBLIC authwit to be stored in the AuthRegistry contract.
 *
 * Solution: Use Azguard's add_public_authwit action within the send_transaction.
 * This follows the pattern from holonym-foundation/aztec-bridge.
 *
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 * @param authwitResult - Result from setAuthwit (currently unused)
 */
export async function lockOnAztec(
  client: AzguardClient,
  caipAccount: string,
  solverAddress: string,
  flow: DepositFlowState,
  destinationAddress: string, // EVM address to receive on Base
  authwitResult: string = 'skip',
): Promise<string> {
  if (!AZTEC_TRAIN_ADDRESS || !AZTEC_TOKEN_ADDRESS) {
    throw new Error('Contract addresses not configured');
  }

  const userAddress = extractAddressFromCaip(caipAccount);

  // Calculate timelock (current time + buffer)
  const timelock = Math.floor(Date.now() / 1000) + DEFAULT_TIMELOCK_SECONDS;

  // Pad strings as required by Aztec contract
  const srcAsset = 'USDC'.padStart(30, ' ');
  const dstChain = 'BASE_SEPOLIA'.padStart(30, ' ');
  const dstAsset = 'USDC'.padStart(30, ' ');
  const dstAddress = destinationAddress.padStart(90, ' ');

  console.log('[Deposit] Setting up lock_src transaction with public authwit...');
  console.log('[Deposit] User:', userAddress);
  console.log('[Deposit] Train contract (caller):', AZTEC_TRAIN_ADDRESS);
  console.log('[Deposit] Token contract:', AZTEC_TOKEN_ADDRESS);
  console.log('[Deposit] Amount:', flow.amount.toString());

  // Create the add_public_authwit action
  // This tells Azguard to authorize the Train contract to call transfer_in_public
  // Following the holonym-foundation/aztec-bridge pattern
  const addPublicAuthwitAction = {
    kind: 'add_public_authwit',
    content: {
      kind: 'call',
      caller: AZTEC_TRAIN_ADDRESS,
      contract: AZTEC_TOKEN_ADDRESS,
      method: AZTEC_TOKEN_METHODS.transfer_in_public,
      args: [
        userAddress,            // from
        AZTEC_TRAIN_ADDRESS,    // to
        flow.amount.toString(), // amount
        '0',                    // nonce
      ],
    },
  };

  // Create lock_src call
  const lockSrcCall = {
    kind: 'call',
    contract: AZTEC_TRAIN_ADDRESS,
    method: AZTEC_TRAIN_METHODS.lock_src,
    args: [
      flow.swapId,
      flow.hashlockHigh.toString(),
      flow.hashlockLow.toString(),
      timelock.toString(),
      solverAddress,
      AZTEC_TOKEN_ADDRESS,
      flow.amount.toString(),
      srcAsset,
      dstChain,
      dstAsset,
      dstAddress,
    ],
  };

  try {
    // Execute add_public_authwit + lock_src in a single transaction
    console.log('[Deposit] Executing add_public_authwit + lock_src...');

    const txOp = {
      kind: 'send_transaction',
      account: caipAccount,
      actions: [addPublicAuthwitAction, lockSrcCall],
      // Enable gas estimation with 50% padding to handle fee fluctuations
      fee: {
        estimateGas: true,
        estimatedGasPadding: 0.5, // 50% buffer for gas price changes
      },
    };

    const results = await (client as any).execute([txOp]);

    if (results?.[0]?.status === 'ok') {
      console.log('[Deposit] lock_src succeeded!');
      return results[0].result as string;
    }

    const errorMsg = results?.[0]?.error || 'Unknown error';
    console.log('[Deposit] Transaction failed:', errorMsg);

    // Check for common error patterns
    if (errorMsg.includes('artifact') || errorMsg.includes('not found') || errorMsg.includes('not registered')) {
      throw new Error(
        `Contract not registered in Azguard. Please ensure the Train contract artifact is uploaded to ` +
        `https://devnet.aztec-registry.xyz/. Error: ${errorMsg}`
      );
    }

    if (errorMsg.includes('unauthorized') || errorMsg.includes('Assertion failed')) {
      throw new Error(
        `Authwit verification failed. This may indicate an issue with the authwit format ` +
        `or chain ID mismatch. Error: ${errorMsg}`
      );
    }

    throw new Error(`Azguard transaction failed: ${errorMsg}`);
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    console.error('[Deposit] Error:', errorMsg);
    throw error;
  }
}

/**
 * Get user's private token balance on Aztec
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function getAztecPrivateBalance(
  client: AzguardClient,
  caipAccount: string,
): Promise<bigint | null> {
  if (!AZTEC_TOKEN_ADDRESS) {
    console.error('[Aztec] AZTEC_TOKEN_ADDRESS not configured!');
    throw new Error('Token address not configured');
  }

  // Extract plain address for contract args
  const userAddress = extractAddressFromCaip(caipAccount);

  try {
    console.log('[Aztec] Fetching private balance...');
    console.log('[Aztec]   User:', userAddress);
    console.log('[Aztec]   Token:', AZTEC_TOKEN_ADDRESS);
    console.log('[Aztec]   CAIP:', caipAccount);

    // Try direct RPC to window.azguard for more control
    // Use batched simulate_views matching exact Azguard docs pattern
    const simulateOp = {
      kind: 'simulate_views',
      account: caipAccount,
      calls: [
        {
          kind: 'call',
          contract: AZTEC_TOKEN_ADDRESS,
          method: AZTEC_TOKEN_METHODS.balance_of_private,
          args: [userAddress],
        },
      ],
    };

    console.log('[Aztec] Executing simulate_views:', JSON.stringify(simulateOp, null, 2));

    const results = await (client as any).execute([simulateOp]);
    console.log('[Aztec] Raw results:', JSON.stringify(results, null, 2));

    if (!results || results.length === 0) {
      throw new Error('Empty results from Azguard');
    }

    if (results[0].status !== 'ok') {
      throw new Error(results[0].error || 'Unknown Azguard error');
    }

    // Extract decoded result
    const decoded = results[0].result?.decoded;
    if (decoded && decoded.length > 0) {
      console.log('[Aztec] Private balance (decoded):', decoded[0]);
      return BigInt(decoded[0]?.toString() || '0');
    }

    console.log('[Aztec] Private balance result:', results[0].result);
    return BigInt(results[0].result?.toString() || '0');
  } catch (error: any) {
    const errorMsg = error?.message || String(error);

    // Log detailed error for debugging
    console.error('[Aztec] Private balance query FAILED');
    console.error('[Aztec]   Error:', errorMsg);

    // WORKAROUND: Azguard Brillig VM bug
    // Azguard's simulate_views fails on balance_of_private with Brillig error
    // even when notes exist (Azguard UI may show correct balance)
    // Return null to keep cached/previous value rather than showing 0
    if (errorMsg.includes('_is_some') || errorMsg.includes('brillig')) {
      console.warn('[Aztec]   ⚠️ Brillig VM error - this is an Azguard bug');
      console.warn('[Aztec]   Azguard simulate_views fails even when notes exist');
      console.warn('[Aztec]   Check Azguard wallet UI for actual balance');
      console.warn('[Aztec]   Try: Clear Azguard data & re-sync, or report to Azguard team');
      // Return null to keep previous/cached balance instead of showing 0
      return null;
    }

    // For other errors, return null to keep previous balance
    return null;
  }
}

/**
 * Get user's public token balance on Aztec
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function getAztecPublicBalance(
  client: AzguardClient,
  caipAccount: string,
): Promise<bigint | null> {
  if (!AZTEC_TOKEN_ADDRESS) {
    throw new Error('Token address not configured');
  }

  // Extract plain address for contract args
  const userAddress = extractAddressFromCaip(caipAccount);

  try {
    const result = await simulateAzguardView(
      client,
      caipAccount,  // CAIP format for Azguard operation
      AZTEC_TOKEN_ADDRESS,
      AZTEC_TOKEN_METHODS.balance_of_public,
      [userAddress],  // Plain address for contract arg
    );

    return BigInt(result?.toString() || '0');
  } catch (error) {
    // Return null to indicate failure - caller should keep previous balance
    console.log('[Aztec] Could not fetch public balance, returning null');
    return null;
  }
}

/**
 * Transfer tokens from private to public on Aztec
 * Required before lock_src which operates on public balance
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function transferToPublic(
  client: AzguardClient,
  caipAccount: string,
  amount: bigint,
): Promise<string> {
  if (!AZTEC_TOKEN_ADDRESS) {
    throw new Error('Token address not configured');
  }

  // Extract plain address for contract args
  const userAddress = extractAddressFromCaip(caipAccount);

  const txHash = await executeAzguardCall(
    client,
    caipAccount,  // CAIP format for Azguard operation
    AZTEC_TOKEN_ADDRESS,
    AZTEC_TOKEN_METHODS.transfer_to_public,
    [
      userAddress,  // from (plain address for contract)
      userAddress,  // to (plain address for contract)
      amount.toString(),
      '0',  // nonce
    ],
  );

  return txHash;
}

/**
 * Get HTLC details from Aztec
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function getAztecHTLC(
  client: AzguardClient,
  caipAccount: string,
  swapId: string,
): Promise<any> {
  if (!AZTEC_TRAIN_ADDRESS) {
    throw new Error('Train address not configured');
  }

  const result = await simulateAzguardView(
    client,
    caipAccount,  // CAIP format for Azguard operation
    AZTEC_TRAIN_ADDRESS,
    AZTEC_TRAIN_METHODS.get_htlc,
    [swapId, '0'],
  );

  return result;
}

/**
 * Check if HTLC exists on Aztec (for shield flow - checking if solver locked)
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function hasAztecHTLC(
  client: AzguardClient,
  caipAccount: string,
  swapId: string,
  htlcId: string = '0',
): Promise<boolean> {
  if (!AZTEC_TRAIN_ADDRESS) {
    throw new Error('Train address not configured');
  }

  try {
    const result = await simulateAzguardView(
      client,
      caipAccount,
      AZTEC_TRAIN_ADDRESS,
      AZTEC_TRAIN_METHODS.has_htlc,
      [swapId, htlcId],
    );

    return Boolean(result);
  } catch (error) {
    console.log('[Aztec] HTLC check failed, assuming does not exist');
    return false;
  }
}

// ==================== AZTEC REFUND ====================

/**
 * Refund tokens on Aztec after timelock expires
 * Can only be called after timelock and if not already redeemed
 * Used when swap fails/times out to recover locked funds
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function refundOnAztec(
  client: AzguardClient,
  caipAccount: string,
  swapId: string,
  htlcId: string = '0',
): Promise<string> {
  if (!AZTEC_TRAIN_ADDRESS) {
    throw new Error('Train address not configured');
  }

  console.log('[Aztec] Refunding HTLC...', { swapId, htlcId });

  const txHash = await executeAzguardCall(
    client,
    caipAccount,
    AZTEC_TRAIN_ADDRESS,
    AZTEC_TRAIN_METHODS.refund,
    [swapId, htlcId],
  );

  console.log('[Aztec] Refund complete:', txHash);
  return txHash;
}

// ==================== AZTEC FAUCET ====================

/**
 * Mint tokens on Aztec (testnet only)
 * NOTE: mint_to_public typically requires admin/minter role.
 * For testnet, tokens should be pre-minted via the deploy script.
 * This function attempts to mint but may fail if user lacks permissions.
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function mintAztecTokens(
  client: AzguardClient,
  caipAccount: string,
  amount: bigint = 1000000000n, // Default 1000 USDC (6 decimals)
): Promise<string> {
  if (!AZTEC_TOKEN_ADDRESS) {
    throw new Error('Aztec token address not configured. Check .env.local');
  }

  // Extract plain address for contract args
  const userAddress = extractAddressFromCaip(caipAccount);

  console.log('[Aztec Faucet] Attempting to mint', amount.toString(), 'to', userAddress);
  console.log('[Aztec Faucet] Token contract:', AZTEC_TOKEN_ADDRESS);
  console.log('[Aztec Faucet] CAIP account:', caipAccount);

  try {
    // Mint to public balance
    const txHash = await executeAzguardCall(
      client,
      caipAccount,  // CAIP format for Azguard operation
      AZTEC_TOKEN_ADDRESS,
      'mint_to_public',
      [userAddress, amount.toString()],  // Plain address for contract arg
    );
    return txHash;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // Provide helpful message if minting fails due to permissions
    if (message.includes('Invalid account') || message.includes('unauthorized')) {
      throw new Error(
        'Mint failed - you may not have minter permissions. ' +
        'For testnet, run the deploy script to mint tokens, or ask the deployer to mint to your address.'
      );
    }
    throw error;
  }
}

/**
 * Full Aztec faucet flow: mint to public, then transfer to private
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function aztecFaucetFlow(
  client: AzguardClient,
  caipAccount: string,
  amount: bigint = 1000000000n,
): Promise<{ mintTxHash: string; transferTxHash: string }> {
  // Step 1: Mint to public
  const mintTxHash = await mintAztecTokens(client, caipAccount, amount);

  // Step 2: Transfer to private
  const transferTxHash = await transferToPrivate(client, caipAccount, amount);

  return { mintTxHash, transferTxHash };
}

/**
 * Transfer tokens from public to private on Aztec
 * @param caipAccount - Full CAIP account format: "aztec:chainId:address"
 */
export async function transferToPrivate(
  client: AzguardClient,
  caipAccount: string,
  amount: bigint,
): Promise<string> {
  if (!AZTEC_TOKEN_ADDRESS) {
    throw new Error('Token address not configured');
  }

  // Extract plain address for contract args
  const userAddress = extractAddressFromCaip(caipAccount);

  const txHash = await executeAzguardCall(
    client,
    caipAccount,  // CAIP format for Azguard operation
    AZTEC_TOKEN_ADDRESS,
    AZTEC_TOKEN_METHODS.transfer_to_private,
    [
      userAddress,  // to (recipient of private tokens)
      amount.toString(),
    ],
  );

  return txHash;
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Convert raw amount to display amount (divide by decimals)
 */
export function formatAmount(rawAmount: bigint): string {
  const divisor = 10n ** TOKEN_DECIMALS;
  const whole = rawAmount / divisor;
  const fraction = rawAmount % divisor;
  return `${whole}.${fraction.toString().padStart(Number(TOKEN_DECIMALS), '0')}`;
}

/**
 * Convert display amount to raw amount (multiply by decimals)
 */
export function parseAmount(displayAmount: string): bigint {
  const [whole, fraction = ''] = displayAmount.split('.');
  const paddedFraction = fraction.padEnd(Number(TOKEN_DECIMALS), '0').slice(0, Number(TOKEN_DECIMALS));
  return BigInt(whole) * 10n ** TOKEN_DECIMALS + BigInt(paddedFraction);
}
