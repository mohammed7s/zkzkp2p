/**
 * Centralized Configuration
 * All magic numbers and environment variables in one place
 */

// ==================== ENVIRONMENT VALIDATION ====================

// Only token addresses are required for Substance bridge
const REQUIRED_ENV_VARS = [
  'NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS',
  'NEXT_PUBLIC_BASE_TOKEN_ADDRESS',
] as const;

// Validate required env vars on load (client-side only)
if (typeof window !== 'undefined') {
  const missing = REQUIRED_ENV_VARS.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error('[Config] Missing required environment variables:', missing);
    console.error('[Config] Check your .env.local file');
  }
}

// ==================== CHAIN CONFIGURATION ====================

export const CHAINS = {
  aztec: {
    chainId: process.env.NEXT_PUBLIC_AZTEC_CHAIN_ID || '1674512022',
    nodeUrl: process.env.NEXT_PUBLIC_AZTEC_NODE_URL || 'https://devnet.aztec-labs.com',
    name: 'Aztec Devnet',
  },
  baseSepolia: {
    chainId: parseInt(process.env.NEXT_PUBLIC_BASE_CHAIN_ID || '84532'),
    rpcUrl: process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://sepolia.base.org',
    name: 'Base Sepolia',
  },
} as const;

// ==================== CONTRACT ADDRESSES ====================

export const CONTRACTS = {
  aztec: {
    train: process.env.NEXT_PUBLIC_AZTEC_TRAIN_ADDRESS || '',
    token: process.env.NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS || '',
  },
  base: {
    train: process.env.NEXT_PUBLIC_BASE_TRAIN_ADDRESS || '',
    token: process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || '',
  },
} as const;

// ==================== SOLVER CONFIGURATION ====================

export const SOLVER = {
  evmAddress: (process.env.NEXT_PUBLIC_SOLVER_EVM_ADDRESS || '') as `0x${string}`,
  aztecAddress: process.env.NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS || '',
  apiUrl: process.env.NEXT_PUBLIC_SOLVER_API_URL || 'http://localhost:3001',
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
  idbStabilizationDelay: 3000,   // Workaround for Azguard IDB issues

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

  // Azguard uses different chain ID for authwit (known bug)
  azguardAuthwitChainId: 11155655,
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
    apiUrl: SOLVER.apiUrl,
  });
}
