import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WalletState {
  // EVM (L1) - Base chain
  evmAddress: `0x${string}` | null;
  isEvmConnected: boolean;

  // Aztec (L2)
  aztecAddress: string | null;
  isAztecConnected: boolean;
  aztecWallet: any | null; // EmbeddedWallet (use any to avoid import issues)
  aztecError: string | null;

  // Transaction state - used to pause balance polling during txs
  isAztecTxPending: boolean;

  // Account deployment state
  isAztecDeployed: boolean | null; // null = unknown, true = deployed, false = not deployed
  isDeployingAztec: boolean;

  // Preferences
  autoConnectAztec: boolean;

  // Actions
  setEvmConnected: (address: `0x${string}` | null) => void;
  setAztecConnected: (address: string | null, wallet: any | null) => void;
  setAztecError: (error: string | null) => void;
  setAztecTxPending: (pending: boolean) => void;
  setAztecDeployed: (deployed: boolean) => void;
  setDeployingAztec: (deploying: boolean) => void;
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
      isAztecDeployed: null,
      isDeployingAztec: false,
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

      setAztecDeployed: (deployed) =>
        set({ isAztecDeployed: deployed }),

      setDeployingAztec: (deploying) =>
        set({ isDeployingAztec: deploying }),

      disconnectAztec: () =>
        set({
          aztecAddress: null,
          isAztecConnected: false,
          aztecWallet: null,
          aztecError: null,
          isAztecTxPending: false,
          isAztecDeployed: null,
          isDeployingAztec: false,
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
          isAztecDeployed: null,
          isDeployingAztec: false,
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
