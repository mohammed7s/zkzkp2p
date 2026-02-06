/**
 * Azguard wallet helper functions
 * Based on patterns from holonym-foundation/aztec-bridge
 */

import { AzguardClient } from '@azguardwallet/client';
import { CHAINS } from '@/config';

// Track registered contracts to avoid duplicate registrations
const registeredContracts = new Set<string>();

// Extend Window interface for Azguard
declare global {
  interface Window {
    azguard?: any;
  }
}

export async function isAzguardInstalled(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  try {
    // Just check if installed, not version compatibility
    // (compatibility check was causing issues)
    return await AzguardClient.isAzguardInstalled();
  } catch {
    return false;
  }
}

export async function connectAzguard(): Promise<{
  client: AzguardClient;
  address: string;
  caipAccount: string;
} | null> {
  if (typeof window === 'undefined') {
    throw new Error('Azguard can only be used in browser');
  }

  // Check for window.azguard first (like Holonym does)
  if (!window.azguard) {
    throw new Error('Azguard wallet extension not detected. Please install from https://azguardwallet.io');
  }

  if (!(await isAzguardInstalled())) {
    throw new Error('Azguard wallet is not installed. Please install from https://azguardwallet.io');
  }

  try {
    // Don't clear session - let Azguard manage its own session state
    // Clearing was causing loss of PXE sync state
    const client = await AzguardClient.create();

    // Get wallet info to discover supported chains
    let supportedChains: string[] = [];
    try {
      const walletInfo = await client.getWalletInfo();
      console.log('[Azguard] Wallet info:', walletInfo);
      console.log('[Azguard] Wallet version:', walletInfo.version);
      console.log('[Azguard] Supported chains:', walletInfo.chains);
      console.log('[Azguard] Current accounts (before connect):', client.accounts);

      // Extract supported chains from wallet info
      if (walletInfo.chains && Array.isArray(walletInfo.chains)) {
        supportedChains = walletInfo.chains;
      }
    } catch (e) {
      console.log('[Azguard] Could not get wallet info:', e);
    }

    if (!client.connected) {
      const configuredChain = `aztec:${CHAINS.aztec.chainId}`;

      // Use supported chains from wallet, or fallback to known devnet chain IDs
      const chainsToRequest = supportedChains.length > 0
        ? supportedChains
        : [configuredChain];

      console.log('[Azguard] Requesting chains:', chainsToRequest);

      // Connect with required permissions including simulate_views for balance checks.
      // Without simulate_views as required, every balance check triggers a popup.
      await client.connect(
        {
          name: 'zkzkp2p',
          description: 'Private liquidity for zkp2p via Aztec',
          url: typeof window !== 'undefined' ? window.location.origin : undefined,
        },
        [
          {
            chains: chainsToRequest,
            methods: ['send_transaction', 'add_private_authwit', 'call', 'simulate_views'],
          },
        ],
        [
          {
            chains: chainsToRequest,
            methods: ['register_contract', 'register_token', 'add_public_authwit', 'aztec_createAuthWit'],
          },
        ]
      );
    }

    // Set up account change handler
    if (client.onAccountsChanged) {
      client.onAccountsChanged.addHandler((accounts: string[]) => {
        console.log('[Azguard] Accounts changed:', accounts);
      });
    }

    // Get account (CAIP format: "aztec:chainId:address")
    const accounts = client.accounts;
    console.log('[Azguard] Raw accounts:', accounts);

    if (!accounts || accounts.length === 0) {
      throw new Error('No Aztec accounts available');
    }

    // Parse CAIP account format
    const caipAccount = accounts[0];
    const parts = caipAccount.split(':');
    const address = parts[parts.length - 1];

    console.log('[Azguard] CAIP account:', caipAccount);
    console.log('[Azguard] Parsed address:', address);

    // Return both formats - CAIP for Azguard operations, plain for display/contract args
    return { client, address, caipAccount };
  } catch (error) {
    console.error('Failed to connect Azguard:', error);
    throw error;
  }
}

export async function disconnectAzguard(client?: AzguardClient): Promise<void> {
  try {
    if (client && typeof client.disconnect === 'function') {
      await client.disconnect();
    }
  } catch (error) {
    console.error('Error disconnecting Azguard:', error);
  }
}

// Operation types for Azguard execute() API
interface AzguardCallOperation {
  kind: 'call';
  contract: string;
  method: string;
  args: any[];
}

interface AzguardSendTransactionOperation {
  kind: 'send_transaction';
  account: string;
  actions: AzguardCallOperation[];
}

interface AzguardSimulateViewsOperation {
  kind: 'simulate_views';
  account: string;
  calls: AzguardCallOperation[];
}

interface AzguardRegisterTokenOperation {
  kind: 'register_token';
  account: string;
  address: string;
}

interface AzguardRegisterContractOperation {
  kind: 'register_contract';
  chain: string;
  address: string;
  artifact?: any;
}

type AzguardOperation =
  | AzguardSendTransactionOperation
  | AzguardSimulateViewsOperation
  | AzguardRegisterTokenOperation
  | AzguardRegisterContractOperation;

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operation} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

/**
 * Execute a contract call via Azguard
 * Uses the execute() API with operation objects
 * Auto-registers contract if artifact not found (fetches from Aztec network)
 * Note: No timeout - user needs time to review and confirm in wallet popup
 */
export async function executeAzguardCall(
  client: AzguardClient,
  account: string,
  contractAddress: string,
  methodName: string,
  args: any[],
  authWitnesses?: Array<{ requestHash: string; witness: any[] }>
): Promise<string> {
  const callOp: AzguardCallOperation = {
    kind: 'call',
    contract: contractAddress,
    method: methodName,
    args,
  };

  const txOp: AzguardSendTransactionOperation & { authWitnesses?: any } = {
    kind: 'send_transaction',
    account,
    actions: [callOp],
  };

  // Add explicit authWitnesses if provided
  if (authWitnesses && authWitnesses.length > 0) {
    txOp.authWitnesses = authWitnesses;
  }

  try {
    console.log(`[Azguard] Executing ${methodName}... (waiting for user confirmation)`);
    const results = await client.execute([txOp]);

    if (!results || results.length === 0 || results[0].status !== 'ok') {
      const errorMsg = results?.[0]?.error || 'Unknown error';

      // Check if error is about contract not being registered
      if (errorMsg.includes('artifact') || errorMsg.includes('not found') || errorMsg.includes('not registered')) {
        console.log('[Azguard] Contract not registered, attempting auto-registration...');

        // Register contract (Azguard fetches artifact from network) and retry
        const registerOp: AzguardRegisterContractOperation = {
          kind: 'register_contract',
          chain: `aztec:${CHAINS.aztec.chainId}`,
          address: contractAddress,
        };

        const retryResults = await client.execute([registerOp, txOp]);

        if (!retryResults || retryResults.length < 2) {
          throw new Error('Azguard returned incomplete results after registration');
        }

        if (retryResults[0].status !== 'ok') {
          const regError = retryResults[0].error || 'Unknown error';
          throw new Error(
            `Contract registration failed. Ensure the contract artifact is uploaded to ` +
            `https://devnet.aztec-registry.xyz/. Error: ${regError}`
          );
        }

        if (retryResults[1].status !== 'ok') {
          throw new Error(`Azguard transaction failed after registration: ${retryResults[1].error}`);
        }

        // Mark as registered in our cache
        registeredContracts.add(contractAddress.toLowerCase());
        console.log('[Azguard] Auto-registration successful');

        return retryResults[1].result as string;
      }

      // Check for authwit failure (Azguard chain ID bug)
      if (errorMsg.includes('unauthorized') || errorMsg.includes('Assertion failed')) {
        throw new Error(
          `Azguard authwit verification failed. This is likely due to Azguard using wrong chain ID ` +
          `(uses different chain ID) for authwit computation. ` +
          `Please report this to the Azguard team. Original error: ${errorMsg.slice(0, 200)}`
        );
      }

      throw new Error(`Azguard transaction failed: ${errorMsg}`);
    }

    return results[0].result as string;
  } catch (error) {
    console.error('Azguard call failed:', error);
    throw error;
  }
}

/**
 * Execute multiple contract calls in a single transaction via Azguard
 * This allows batching operations for a single user signature
 * Note: No timeout - user needs time to review and confirm in wallet popup
 */
export async function executeAzguardBatch(
  client: AzguardClient,
  account: string,
  operations: Array<{ contract: string; method: string; args: any[] }>
): Promise<string> {
  const callOps: AzguardCallOperation[] = operations.map(op => ({
    kind: 'call' as const,
    contract: op.contract,
    method: op.method,
    args: op.args,
  }));

  const txOp: AzguardSendTransactionOperation = {
    kind: 'send_transaction',
    account,
    actions: callOps,
  };

  try {
    const methodNames = operations.map(op => op.method).join(' + ');
    console.log(`[Azguard] Executing batch [${methodNames}]... (waiting for user confirmation)`);

    const results = await client.execute([txOp]);

    if (!results || results.length === 0 || results[0].status !== 'ok') {
      const errorMsg = results?.[0]?.error || 'Unknown error';
      throw new Error(`Azguard batch transaction failed: ${errorMsg}`);
    }

    return results[0].result as string;
  } catch (error) {
    console.error('Azguard batch call failed:', error);
    throw error;
  }
}

/**
 * Simulate a view function via Azguard
 * Auto-registers contract if artifact not found (fetches from Aztec network)
 */
export async function simulateAzguardView(
  client: AzguardClient,
  account: string,
  contractAddress: string,
  methodName: string,
  args: any[],
  timeoutMs: number = 60000 // 1 minute default for views
): Promise<any> {
  const callOp: AzguardCallOperation = {
    kind: 'call',
    contract: contractAddress,
    method: methodName,
    args,
  };

  const simulateOp: AzguardSimulateViewsOperation = {
    kind: 'simulate_views',
    account,
    calls: [callOp],
  };

  try {
    console.log(`[Azguard] Simulating ${methodName}... (timeout: ${timeoutMs / 1000}s)`);
    const results = await withTimeout<any[]>(
      client.execute([simulateOp]),
      timeoutMs,
      `Azguard view ${methodName}`
    );

    if (!results || results.length === 0 || results[0].status !== 'ok') {
      const errorMsg = results?.[0]?.error || 'Unknown error';

      // Check if error is about contract not being registered
      if (errorMsg.includes('artifact') || errorMsg.includes('not found') || errorMsg.includes('not registered')) {
        console.log('[Azguard] Contract not registered for view, attempting auto-registration...');

        // Register contract (Azguard fetches artifact from network) and retry
        const registerOp: AzguardRegisterContractOperation = {
          kind: 'register_contract',
          chain: `aztec:${CHAINS.aztec.chainId}`,
          address: contractAddress,
        };

        const retryResults = await client.execute([registerOp, simulateOp]);

        if (!retryResults || retryResults.length < 2) {
          throw new Error('Azguard returned incomplete results after registration');
        }

        if (retryResults[0].status !== 'ok') {
          const regError = retryResults[0].error || 'Unknown error';
          throw new Error(
            `Contract registration failed. Ensure the contract artifact is uploaded to ` +
            `https://devnet.aztec-registry.xyz/. Error: ${regError}`
          );
        }

        if (retryResults[1].status !== 'ok') {
          throw new Error(`Azguard simulation failed after registration: ${retryResults[1].error}`);
        }

        // Mark as registered in our cache
        registeredContracts.add(contractAddress.toLowerCase());
        console.log('[Azguard] Auto-registration successful for view');

        // Return decoded result
        const result = retryResults[1].result as any;
        if (result?.decoded && result.decoded.length > 0) {
          return result.decoded[0];
        }
        return result;
      }

      throw new Error(`Azguard simulation failed: ${errorMsg}`);
    }

    // Return decoded result
    const result = results[0].result as any;
    if (result?.decoded && result.decoded.length > 0) {
      return result.decoded[0];
    }
    return result;
  } catch (error) {
    console.error('Azguard view simulation failed:', error);
    throw error;
  }
}

/**
 * Register a token with Azguard wallet
 */
export async function registerAzguardToken(
  client: AzguardClient,
  account: string,
  tokenAddress: string
): Promise<void> {
  try {
    const registerOp: AzguardRegisterTokenOperation = {
      kind: 'register_token',
      account,
      address: tokenAddress,
    };

    const results = await client.execute([registerOp]);

    if (!results || results.length === 0 || results[0].status !== 'ok') {
      const errorMsg = results?.[0]?.error || 'Unknown error';
      throw new Error(`Azguard token registration failed: ${errorMsg}`);
    }
  } catch (error) {
    console.error('Failed to register token:', error);
    throw error;
  }
}

/**
 * Register a contract with Azguard wallet
 * Azguard fetches artifacts from the Aztec registry (devnet.aztec-registry.xyz)
 * Contract must be uploaded there first for this to work
 */
export async function registerAzguardContract(
  client: AzguardClient,
  contractAddress: string,
  _artifact?: any, // Not used - Azguard fetches from network
  timeoutMs: number = 120000 // 2 minute timeout for registration (devnet can be slow)
): Promise<void> {
  // Check if already registered in this session
  const key = `${contractAddress.toLowerCase()}`;
  if (registeredContracts.has(key)) {
    console.log('[Azguard] Contract already registered in session:', contractAddress.slice(0, 10) + '...');
    return;
  }

  try {
    console.log('[Azguard] Registering contract (Azguard will fetch artifact from network):', contractAddress.slice(0, 10) + '...');

    // Don't pass artifact - Azguard fetches it from the Aztec registry
    const registerOp: AzguardRegisterContractOperation = {
      kind: 'register_contract',
      chain: `aztec:${CHAINS.aztec.chainId}`,
      address: contractAddress,
      // instance and artifact are NOT passed - Azguard fetches them from PXE/node
    };

    const results = await withTimeout<any[]>(
      client.execute([registerOp]),
      timeoutMs,
      'Azguard contract registration'
    );
    console.log('[Azguard] Registration response:', JSON.stringify(results));

    if (!results || results.length === 0) {
      throw new Error('Azguard returned empty result for contract registration');
    }

    // Handle both success and "already registered" cases
    if (results[0].status === 'ok') {
      registeredContracts.add(key);
      console.log('[Azguard] Contract registered successfully');
    } else if (results[0].error?.includes('already registered') || results[0].error?.includes('already exists')) {
      // Contract was already registered in Azguard - that's fine
      registeredContracts.add(key);
      console.log('[Azguard] Contract was already registered in Azguard');
    } else {
      const errorMsg = results[0].error || 'Unknown error';
      // Check if it's an artifact not found error
      if (errorMsg.includes('artifact') || errorMsg.includes('not found')) {
        throw new Error(
          `Contract artifact not found on Aztec network. ` +
          `Please ensure the Train contract artifact is uploaded to https://devnet.aztec-registry.xyz/`
        );
      }
      throw new Error(`Azguard contract registration failed: ${errorMsg}`);
    }
  } catch (error) {
    console.error('[Azguard] Failed to register contract:', error);
    throw error;
  }
}

/**
 * Batch query both public and private balances in a single simulate_views operation.
 * Following EXACT Azguard docs pattern for balance queries.
 *
 * Returns { publicBalance, privateBalance } or throws on error.
 */
export async function batchQueryBalances(
  client: AzguardClient,
  account: string,
  tokenAddress: string,
  timeoutMs: number = 90000 // 1.5 minutes
): Promise<{ publicBalance: bigint; privateBalance: bigint }> {
  // Extract plain address from CAIP account
  const address = account.split(':').pop()!;

  console.log('[Azguard] Querying balances (exact docs pattern)...');
  console.log('[Azguard]   Account:', account);
  console.log('[Azguard]   Token:', tokenAddress);
  console.log('[Azguard]   Address:', address);

  try {
    // Try private FIRST - maybe order matters for Azguard's internal state
    const simulateOp: AzguardSimulateViewsOperation = {
      kind: 'simulate_views',
      account,
      calls: [
        {
          kind: 'call',
          contract: tokenAddress,
          method: 'balance_of_private',
          args: [address],
        },
        {
          kind: 'call',
          contract: tokenAddress,
          method: 'balance_of_public',
          args: [address],
        },
      ],
    };

    console.log('[Azguard] Executing simulate_views...');
    console.log('[Azguard] Operation:', JSON.stringify(simulateOp, null, 2));

    const results = await withTimeout<any[]>(
      client.execute([simulateOp]),
      timeoutMs,
      'Azguard balance query'
    );

    console.log('[Azguard] Raw results:', JSON.stringify(results, null, 2));

    const simResult = results[0];
    if (!simResult || simResult.status !== 'ok') {
      const errorMsg = simResult?.error || 'Unknown error';
      throw new Error(`Azguard simulate_views failed: ${errorMsg}`);
    }

    // Extract decoded results (private is first, public is second)
    const decoded = simResult.result?.decoded;
    if (!decoded || decoded.length < 2) {
      console.log('[Azguard] Result structure:', JSON.stringify(simResult.result, null, 2));
      throw new Error('Azguard returned incomplete balance results');
    }

    const privateBalance = BigInt(decoded[0]?.toString() || '0');
    const publicBalance = BigInt(decoded[1]?.toString() || '0');

    console.log('[Azguard] Balances - Public:', publicBalance.toString(), 'Private:', privateBalance.toString());

    return { publicBalance, privateBalance };
  } catch (error) {
    console.error('[Azguard] Balance query failed:', error);
    throw error;
  }
}

/**
 * Shorten address for display
 */
export function shortenAddress(address: string, chars = 4): string {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}
