/**
 * Centralized Configuration
 * All magic numbers and environment variables in one place
 */

import { base, baseSepolia } from 'viem/chains';

// ==================== ENVIRONMENT VALIDATION ====================

// Validate required env vars on load (client-side only)
// Note: Next.js only inlines NEXT_PUBLIC_* with static string literals,
// so we check the actual resolved values, not dynamic process.env[key].
if (typeof window !== 'undefined') {
  if (!import.meta.env.NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS) {
    console.error('[Config] Missing required environment variables. Check your .env.local file');
  }
}

export const BASE_NETWORK = import.meta.env.NEXT_PUBLIC_BASE_NETWORK === 'sepolia' ? 'sepolia' : 'mainnet';

const BASE_NETWORK_DEFAULTS = {
  mainnet: {
    chain: base,
    rpcUrl: 'https://mainnet.base.org',
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    explorerUrl: 'https://basescan.org',
  },
  sepolia: {
    chain: baseSepolia,
    rpcUrl: 'https://sepolia.base.org',
    tokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorerUrl: 'https://sepolia.basescan.org',
  },
} as const;

const activeBaseNetwork = BASE_NETWORK_DEFAULTS[BASE_NETWORK];

export const BASE_CHAIN = activeBaseNetwork.chain;
export const BASE_EXPLORER_URL = activeBaseNetwork.explorerUrl;
export function getBaseTxExplorerUrl(txHash: string): string {
  return `${BASE_EXPLORER_URL}/tx/${txHash}`;
}

// ==================== CHAIN CONFIGURATION ====================

export const CHAINS = {
  aztec: {
    chainId: import.meta.env.NEXT_PUBLIC_AZTEC_CHAIN_ID || '11155111',
    nodeUrl: import.meta.env.NEXT_PUBLIC_AZTEC_NODE_URL || 'https://rpc.testnet.aztec-labs.com',
    name: 'Aztec Testnet',
  },
  base: {
    chainId: parseInt(import.meta.env.NEXT_PUBLIC_BASE_CHAIN_ID || String(BASE_CHAIN.id)),
    rpcUrl: import.meta.env.NEXT_PUBLIC_BASE_RPC_URL || activeBaseNetwork.rpcUrl,
    name: BASE_CHAIN.name,
  },
} as const;

// ==================== CONTRACT ADDRESSES ====================

export const CONTRACTS = {
  aztec: {
    train: import.meta.env.NEXT_PUBLIC_AZTEC_TRAIN_ADDRESS || '',
    token: import.meta.env.NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS || '',
  },
  base: {
    train: import.meta.env.NEXT_PUBLIC_BASE_TRAIN_ADDRESS || '',
    token: import.meta.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || activeBaseNetwork.tokenAddress,
  },
} as const;

// ==================== SOLVER CONFIGURATION ====================

export const SOLVER = {
  evmAddress: (import.meta.env.NEXT_PUBLIC_SOLVER_EVM_ADDRESS || '') as `0x${string}`,
  aztecAddress: import.meta.env.NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS || '',
} as const;

// ==================== TIMING CONFIGURATION ====================

export const TIMING = {
  // Solver polling
  solverPollInterval: 5000,      // 5 seconds between checks
  solverMaxWait: 300000,         // 5 minutes max wait for solver

  // Balance polling
  balancePollInterval: 30000,    // 30 seconds

  // HTLC configuration
  defaultTimelockSeconds: 7200,  // 2 hours

  // UI delays
  balanceRefreshDelay: 2000,     // Delay before refreshing balances after tx
  idbStabilizationDelay: 3000,   // Delay for PXE initialization

  // View simulation timeout
  viewSimulationTimeout: 60000,  // 1 minute for view calls
  contractRegistrationTimeout: 120000, // 2 minutes for contract registration
} as const;

// ==================== TOKEN CONFIGURATION ====================

export const TOKEN = {
  decimals: 6n,  // USDC has 6 decimals
  symbol: 'USDC',
} as const;

// ==================== ZKP2P CONFIGURATION ====================

export const ZKP2P = {
  // Default conversion rate: 1.02 (2% premium)
  defaultConversionRate: '1020000000000000000',
  premiumPercent: 2,

  // Supported payment methods and currencies
  paymentMethods: ['revolut', 'wise', 'venmo'] as const,
  currencies: ['USD', 'EUR', 'GBP'] as const,
} as const;

// ==================== PROTOCOL CONSTANTS ====================

export const PROTOCOL = {
  // Aztec network version for authwit computation
  aztecVersion: 1,

  // Minimum solver reward (10% of amount)
  minSolverRewardPercent: 10,

  // Legacy chain ID for authwit computation
  authwitChainId: 11155655,
} as const;

// ==================== STORAGE KEYS ====================

export const STORAGE_KEYS = {
  flows: 'zkzkp2p-flows',
  balanceCache: 'zkzkp2p-balance-cache',
  activeShieldFlow: 'zkzkp2p-shield-flow',
} as const;

// ==================== HELPER FUNCTIONS ====================

/**
 * Check if all required contracts are configured
 */
export function isContractsConfigured(): boolean {
  return !!(
    CONTRACTS.aztec.train &&
    CONTRACTS.aztec.token &&
    CONTRACTS.base.train &&
    CONTRACTS.base.token
  );
}

/**
 * Check if solver is configured
 */
export function isSolverConfigured(): boolean {
  return !!(SOLVER.aztecAddress && SOLVER.evmAddress);
}

/**
 * Log current configuration (for debugging)
 */
export function logConfig(): void {
  console.log('[Config] Base network:', BASE_NETWORK);
  console.log('[Config] Chains:', CHAINS);
  console.log('[Config] Contracts:', {
    aztec: {
      train: CONTRACTS.aztec.train || '(not set)',
      token: CONTRACTS.aztec.token || '(not set)',
    },
    base: {
      train: CONTRACTS.base.train || '(not set)',
      token: CONTRACTS.base.token || '(not set)',
    },
  });
  console.log('[Config] Solver:', {
    evmAddress: SOLVER.evmAddress || '(not set)',
    aztecAddress: SOLVER.aztecAddress || '(not set)',
  });
}
