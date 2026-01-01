import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AzguardClient } from '@azguardwallet/client';

interface WalletState {
  // EVM (L1) - Base chain
  evmAddress: `0x${string}` | null;
  isEvmConnected: boolean;

  // Aztec (L2)
  aztecAddress: string | null;  // Plain address for display/contract args
  aztecCaipAccount: string | null;  // Full CAIP format for Azguard operations
  isAztecConnected: boolean;
  azguardClient: AzguardClient | null;
  aztecError: string | null;

  // Transaction state - used to pause balance polling during txs
  // (Azguard has IDB issues with concurrent operations)
  isAztecTxPending: boolean;

  // Preferences
  autoConnectAztec: boolean;

  // Actions
  setEvmConnected: (address: `0x${string}` | null) => void;
  setAztecConnected: (address: string | null, caipAccount: string | null, client: AzguardClient | null) => void;
  setAztecError: (error: string | null) => void;
  setAztecTxPending: (pending: boolean) => void;
  disconnectAztec: () => void;
  disconnectAll: () => void;
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      // Initial state
      evmAddress: null,
      isEvmConnected: false,
      aztecAddress: null,
      aztecCaipAccount: null,
      isAztecConnected: false,
      azguardClient: null,
      aztecError: null,
      isAztecTxPending: false,
      autoConnectAztec: true,

      // EVM actions
      setEvmConnected: (address) =>
        set({
          evmAddress: address,
          isEvmConnected: !!address,
        }),

      // Aztec actions
      setAztecConnected: (address, caipAccount, client) =>
        set({
          aztecAddress: address,
          aztecCaipAccount: caipAccount,
          isAztecConnected: !!address,
          azguardClient: client,
          aztecError: null,
        }),

      setAztecError: (error) =>
        set({ aztecError: error }),

      setAztecTxPending: (pending) =>
        set({ isAztecTxPending: pending }),

      disconnectAztec: () =>
        set({
          aztecAddress: null,
          aztecCaipAccount: null,
          isAztecConnected: false,
          azguardClient: null,
          aztecError: null,
          isAztecTxPending: false,
        }),

      disconnectAll: () =>
        set({
          evmAddress: null,
          isEvmConnected: false,
          aztecAddress: null,
          aztecCaipAccount: null,
          isAztecConnected: false,
          azguardClient: null,
          aztecError: null,
          isAztecTxPending: false,
        }),
    }),
    {
      name: 'zkzkp2p-wallet',
      partialize: (state) => ({
        // Only persist preferences, not connection state
        autoConnectAztec: state.autoConnectAztec,
      }),
    }
  )
);
