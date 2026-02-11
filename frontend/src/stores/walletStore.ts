import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WalletState {
  // EVM (L1) - Base chain
  evmAddress: `0x${string}` | null;
  isEvmConnected: boolean;

  // Aztec (L2)
  aztecAddress: string | null;
  isAztecConnected: boolean;
  aztecWallet: any | null; // BrowserEmbeddedWallet (use any to avoid import issues)
  aztecError: string | null;

  // Transaction state - used to pause balance polling during txs
  isAztecTxPending: boolean;

  // Preferences
  autoConnectAztec: boolean;

  // Actions
  setEvmConnected: (address: `0x${string}` | null) => void;
  setAztecConnected: (address: string | null, wallet: any | null) => void;
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
      isAztecConnected: false,
      aztecWallet: null,
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
      setAztecConnected: (address, wallet) =>
        set({
          aztecAddress: address,
          isAztecConnected: !!address,
          aztecWallet: wallet,
          aztecError: null,
        }),

      setAztecError: (error) =>
        set({ aztecError: error }),

      setAztecTxPending: (pending) =>
        set({ isAztecTxPending: pending }),

      disconnectAztec: () =>
        set({
          aztecAddress: null,
          isAztecConnected: false,
          aztecWallet: null,
          aztecError: null,
          isAztecTxPending: false,
        }),

      disconnectAll: () =>
        set({
          evmAddress: null,
          isEvmConnected: false,
          aztecAddress: null,
          isAztecConnected: false,
          aztecWallet: null,
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
