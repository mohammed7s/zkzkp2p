/**
 * Coinbase Paymaster Integration
 *
 * Uses permissionless.js with Coinbase's Paymaster & Bundler for gasless transactions.
 * The burner EOA becomes a SimpleSmartAccount, and all gas is sponsored.
 *
 * Docs: https://docs.pimlico.io/permissionless
 */

import { http, createPublicClient, type Hex, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { entryPoint07Address } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { createSmartAccountClient } from 'permissionless';
import { toSimpleSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';

// Get RPC URL from env - this should be your Coinbase Paymaster endpoint
// Format: https://api.developer.coinbase.com/rpc/v1/base-sepolia/<API_KEY>
function getPaymasterRpcUrl(): string {
  const url = process.env.NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL;
  if (!url) {
    throw new Error(
      'NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL not set. ' +
      'Get one at https://portal.cdp.coinbase.com/ and add to .env.local'
    );
  }
  return url;
}

/**
 * Check if paymaster is configured
 */
export function isPaymasterConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL;
}

/**
 * Create a public client connected to the Coinbase Paymaster RPC
 */
export function createPaymasterPublicClient(): PublicClient {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(getPaymasterRpcUrl()),
  }) as PublicClient;
}

/**
 * Create a SimpleSmartAccount from a private key
 *
 * This wraps an EOA private key in a smart account that can use paymasters.
 * The smart account address is deterministically derived from the private key.
 */
export async function createBurnerSmartAccount(
  publicClient: PublicClient,
  privateKey: Hex
) {
  const owner = privateKeyToAccount(privateKey);

  const account = await toSimpleSmartAccount({
    client: publicClient as any,
    owner,
    entryPoint: {
      address: entryPoint07Address,
      version: '0.7',
    },
  });

  return account;
}

/**
 * Create a smart account client with Coinbase Paymaster sponsorship
 *
 * All transactions sent through this client will have gas sponsored.
 */
export async function createSponsoredSmartAccountClient(privateKey: Hex) {
  const rpcUrl = getPaymasterRpcUrl();

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  // Create the paymaster client (handles gas sponsorship)
  const paymasterClient = createPimlicoClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
    entryPoint: {
      address: entryPoint07Address,
      version: '0.7',
    },
  });

  // Create the smart account from the burner private key
  const smartAccount = await createBurnerSmartAccount(publicClient as PublicClient, privateKey);

  // Create the smart account client with paymaster
  const smartAccountClient = createSmartAccountClient({
    account: smartAccount,
    chain: baseSepolia,
    paymaster: paymasterClient,
    bundlerTransport: http(rpcUrl),
    userOperation: {
      estimateFeesPerGas: async () => {
        const gasPrice = await paymasterClient.getUserOperationGasPrice();
        return gasPrice.fast;
      },
    },
  });

  return smartAccountClient;
}

/**
 * Get the smart account address for a given private key
 *
 * This is deterministic - same private key always gives same smart account address.
 * Useful for predicting the address before any transactions.
 */
export async function getSmartAccountAddress(privateKey: Hex): Promise<Hex> {
  const publicClient = createPaymasterPublicClient();
  const account = await createBurnerSmartAccount(publicClient, privateKey);
  return account.address;
}
