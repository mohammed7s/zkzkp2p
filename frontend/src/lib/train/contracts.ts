/**
 * Train Protocol contract addresses and ABIs
 * Based on train-contracts/chains/aztec/scripts/zkp2p/zkp2p-testnet.ts
 */

// ==================== CHAIN CONFIGURATION ====================

// Aztec Devnet (matching Azguard chain ID)
export const AZTEC_CHAIN_ID = '1674512022';
export const AZTEC_NODE_URL = 'https://devnet.aztec-labs.com';

// Base Sepolia
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

// ==================== CONTRACT ADDRESSES ====================

// These should match your .env.testnet values
// TODO: Make these configurable via env vars

// Aztec Devnet - Train and Token contracts
export const AZTEC_TRAIN_ADDRESS = process.env.NEXT_PUBLIC_AZTEC_TRAIN_ADDRESS || '';
export const AZTEC_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS || '';

// Base Sepolia - Train ERC20 and USDC Mock
export const BASE_TRAIN_ADDRESS = process.env.NEXT_PUBLIC_BASE_TRAIN_ADDRESS || '';
export const BASE_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS || '';

// Solver addresses (for testnet - these are our solver's addresses)
export const SOLVER_EVM_ADDRESS = (process.env.NEXT_PUBLIC_SOLVER_EVM_ADDRESS || '0x8ff2c11118ed9c7839b03dc9f4d4d6a479de3c95') as `0x${string}`;
export const SOLVER_AZTEC_ADDRESS = process.env.NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS || '';
export const SOLVER_API_URL = process.env.NEXT_PUBLIC_SOLVER_API_URL || 'http://localhost:3001';

// Log contract addresses for debugging
if (typeof window !== 'undefined') {
  console.log('[Contracts] Aztec Train:', AZTEC_TRAIN_ADDRESS || '(not set)');
  console.log('[Contracts] Aztec Token:', AZTEC_TOKEN_ADDRESS || '(not set)');
  console.log('[Contracts] Base Train:', BASE_TRAIN_ADDRESS || '(not set)');
  console.log('[Contracts] Base Token:', BASE_TOKEN_ADDRESS || '(not set)');
}

// ==================== EVM ABIs ====================

// Using JSON ABI format for better compatibility with viem
export const TRAIN_ERC20_ABI = [
  {
    name: 'lock',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'Id', type: 'bytes32' },
          { name: 'hashlock', type: 'bytes32' },
          { name: 'reward', type: 'uint256' },
          { name: 'rewardTimelock', type: 'uint48' },
          { name: 'timelock', type: 'uint48' },
          { name: 'srcReceiver', type: 'address' },
          { name: 'srcAsset', type: 'string' },
          { name: 'dstChain', type: 'string' },
          { name: 'dstAddress', type: 'string' },
          { name: 'dstAsset', type: 'string' },
          { name: 'amount', type: 'uint256' },
          { name: 'tokenContract', type: 'address' },
        ],
      },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'redeem',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'Id', type: 'bytes32' },
      { name: 'secret', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'getHTLCDetails',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'Id', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'amount', type: 'uint256' },
          { name: 'hashlock', type: 'bytes32' },
          { name: 'secret', type: 'uint256' },
          { name: 'tokenContract', type: 'address' },
          { name: 'timelock', type: 'uint48' },
          { name: 'claimed', type: 'uint8' },
          { name: 'sender', type: 'address' },
          { name: 'srcReceiver', type: 'address' },
        ],
      },
    ],
  },
  {
    name: 'TokenLocked',
    type: 'event',
    inputs: [
      { name: 'Id', type: 'bytes32', indexed: true },
      { name: 'hashlock', type: 'bytes32', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'tokenContract', type: 'address', indexed: false },
      { name: 'timelock', type: 'uint48', indexed: false },
      { name: 'sender', type: 'address', indexed: false },
      { name: 'srcReceiver', type: 'address', indexed: false },
      { name: 'srcAsset', type: 'string', indexed: false },
      { name: 'dstChain', type: 'string', indexed: false },
      { name: 'dstAddress', type: 'string', indexed: false },
      { name: 'dstAsset', type: 'string', indexed: false },
    ],
  },
  {
    name: 'TokenRedeemed',
    type: 'event',
    inputs: [
      { name: 'Id', type: 'bytes32', indexed: true },
      { name: 'redeemAddress', type: 'address', indexed: false },
      { name: 'secret', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'refund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'Id', type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'TokenRefunded',
    type: 'event',
    inputs: [
      { name: 'Id', type: 'bytes32', indexed: true },
      { name: 'refundAddress', type: 'address', indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function faucet() external', // USDCMock faucet - mints 1000 USDC
  'function transfer(address to, uint256 amount) returns (bool)',
] as const;

// ==================== AZTEC METHOD NAMES ====================

// Train contract methods (for Azguard execute)
export const AZTEC_TRAIN_METHODS = {
  lock_src: 'lock_src',
  lock_dst: 'lock_dst',
  redeem: 'redeem',
  refund: 'refund',
  get_htlc: 'get_htlc',
  get_htlc_public: 'get_htlc_public',
  has_htlc: 'has_htlc',
} as const;

// Token contract methods
export const AZTEC_TOKEN_METHODS = {
  balance_of_private: 'balance_of_private',
  balance_of_public: 'balance_of_public',
  transfer_to_public: 'transfer_to_public',
  transfer_to_private: 'transfer_to_private',
  transfer_in_public: 'transfer_in_public',
} as const;

// ==================== CONSTANTS ====================

export const TOKEN_DECIMALS = 6n; // USDC has 6 decimals
export const DEFAULT_TIMELOCK_SECONDS = 7200; // 2 hours

// Aztec network version (used for authwit computation)
export const AZTEC_VERSION = 1;

// WORKAROUND: Azguard uses a different chain ID for authwit computation
// They're using 11155655 (0x00aa36a7) instead of the Aztec devnet ID
// See error context: chainId: { asBuffer: <Buffer 00 00 ... 00 aa 36 a7> }
// This is a known Azguard bug - we'll match their ID for now
export const AZGUARD_AUTHWIT_CHAIN_ID = 11155655;
