/**
 * Flow State Store
 * Manages shield and deposit flows with localStorage persistence for recovery
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ShieldFlowState, ShieldStatus } from '../lib/train/shield';
import type { DepositFlowState, DepositStatus } from '../lib/train/deposit';

// ==================== SERIALIZABLE STATE ====================

// Store secrets as strings for JSON serialization
interface SerializedShieldFlow {
  status: ShieldStatus;
  swapId: string;
  amount: string; // bigint as string
  secretHigh: string;
  secretLow: string;
  hashlockHigh: string;
  hashlockLow: string;
  baseLockTxHash?: string;
  aztecLockTxHash?: string;
  aztecRedeemTxHash?: string;
  error?: string;
  createdAt: number;
}

interface SerializedDepositFlow {
  status: DepositStatus;
  swapId: string;
  amount: string;
  secretHigh: string;
  secretLow: string;
  hashlockHigh: string;
  hashlockLow: string;
  aztecLockTxHash?: string;
  evmLockTxHash?: string;
  evmRedeemTxHash?: string;
  zkp2pDepositId?: string;
  error?: string;
  createdAt: number;
}

// ==================== STORE STATE ====================

interface FlowState {
  // Active flows (one of each type at a time)
  activeShieldFlow: SerializedShieldFlow | null;
  activeDepositFlow: SerializedDepositFlow | null;

  // Flow history (completed or failed)
  completedFlows: (SerializedShieldFlow | SerializedDepositFlow)[];

  // UI state
  isExecuting: boolean;

  // Actions
  startShieldFlow: (flow: ShieldFlowState) => void;
  updateShieldFlow: (updates: Partial<ShieldFlowState>) => void;
  completeShieldFlow: () => void;
  failShieldFlow: (error: string) => void;

  startDepositFlow: (flow: DepositFlowState) => void;
  updateDepositFlow: (updates: Partial<DepositFlowState>) => void;
  completeDepositFlow: () => void;
  failDepositFlow: (error: string) => void;

  setExecuting: (executing: boolean) => void;
  clearActiveFlows: () => void;

  // Recovery helpers
  getActiveShieldFlow: () => ShieldFlowState | null;
  getActiveDepositFlow: () => DepositFlowState | null;
}

// ==================== SERIALIZATION HELPERS ====================

function serializeShieldFlow(flow: ShieldFlowState): SerializedShieldFlow {
  return {
    ...flow,
    amount: flow.amount.toString(),
    secretHigh: flow.secretHigh.toString(),
    secretLow: flow.secretLow.toString(),
    hashlockHigh: flow.hashlockHigh.toString(),
    hashlockLow: flow.hashlockLow.toString(),
    createdAt: Date.now(),
  };
}

function deserializeShieldFlow(flow: SerializedShieldFlow): ShieldFlowState {
  return {
    status: flow.status,
    swapId: flow.swapId,
    amount: BigInt(flow.amount),
    secretHigh: BigInt(flow.secretHigh),
    secretLow: BigInt(flow.secretLow),
    hashlockHigh: BigInt(flow.hashlockHigh),
    hashlockLow: BigInt(flow.hashlockLow),
    baseLockTxHash: flow.baseLockTxHash,
    aztecLockTxHash: flow.aztecLockTxHash,
    aztecRedeemTxHash: flow.aztecRedeemTxHash,
    error: flow.error,
  };
}

function serializeDepositFlow(flow: DepositFlowState): SerializedDepositFlow {
  return {
    ...flow,
    amount: flow.amount.toString(),
    secretHigh: flow.secretHigh.toString(),
    secretLow: flow.secretLow.toString(),
    hashlockHigh: flow.hashlockHigh.toString(),
    hashlockLow: flow.hashlockLow.toString(),
    createdAt: Date.now(),
  };
}

function deserializeDepositFlow(flow: SerializedDepositFlow): DepositFlowState {
  return {
    status: flow.status,
    swapId: flow.swapId,
    amount: BigInt(flow.amount),
    secretHigh: BigInt(flow.secretHigh),
    secretLow: BigInt(flow.secretLow),
    hashlockHigh: BigInt(flow.hashlockHigh),
    hashlockLow: BigInt(flow.hashlockLow),
    aztecLockTxHash: flow.aztecLockTxHash,
    evmLockTxHash: flow.evmLockTxHash,
    evmRedeemTxHash: flow.evmRedeemTxHash,
    zkp2pDepositId: flow.zkp2pDepositId,
    error: flow.error,
  };
}

// ==================== STORE ====================

export const useFlowStore = create<FlowState>()(
  persist(
    (set, get) => ({
      // Initial state
      activeShieldFlow: null,
      activeDepositFlow: null,
      completedFlows: [],
      isExecuting: false,

      // Shield flow actions
      startShieldFlow: (flow: ShieldFlowState) => {
        set({
          activeShieldFlow: serializeShieldFlow(flow),
          isExecuting: true,
        });
      },

      updateShieldFlow: (updates: Partial<ShieldFlowState>) => {
        const current = get().activeShieldFlow;
        if (!current) return;

        const currentFlow = deserializeShieldFlow(current);
        const updatedFlow = { ...currentFlow, ...updates };
        set({
          activeShieldFlow: serializeShieldFlow(updatedFlow),
        });
      },

      completeShieldFlow: () => {
        const current = get().activeShieldFlow;
        if (current) {
          set((state) => ({
            activeShieldFlow: null,
            completedFlows: [...state.completedFlows, { ...current, status: 'COMPLETE' as ShieldStatus }],
            isExecuting: false,
          }));
        }
      },

      failShieldFlow: (error: string) => {
        const current = get().activeShieldFlow;
        if (current) {
          set((state) => ({
            activeShieldFlow: { ...current, status: 'ERROR' as ShieldStatus, error },
            isExecuting: false,
          }));
        }
      },

      // Deposit flow actions
      startDepositFlow: (flow: DepositFlowState) => {
        set({
          activeDepositFlow: serializeDepositFlow(flow),
          isExecuting: true,
        });
      },

      updateDepositFlow: (updates: Partial<DepositFlowState>) => {
        const current = get().activeDepositFlow;
        if (!current) return;

        const currentFlow = deserializeDepositFlow(current);
        const updatedFlow = { ...currentFlow, ...updates };
        set({
          activeDepositFlow: serializeDepositFlow(updatedFlow),
        });
      },

      completeDepositFlow: () => {
        const current = get().activeDepositFlow;
        if (current) {
          set((state) => ({
            activeDepositFlow: null,
            completedFlows: [...state.completedFlows, { ...current, status: 'COMPLETE' as DepositStatus }],
            isExecuting: false,
          }));
        }
      },

      failDepositFlow: (error: string) => {
        const current = get().activeDepositFlow;
        if (current) {
          set((state) => ({
            activeDepositFlow: { ...current, status: 'ERROR' as DepositStatus, error },
            isExecuting: false,
          }));
        }
      },

      // UI state
      setExecuting: (executing: boolean) => set({ isExecuting: executing }),

      clearActiveFlows: () =>
        set({
          activeShieldFlow: null,
          activeDepositFlow: null,
          isExecuting: false,
        }),

      // Recovery helpers
      getActiveShieldFlow: () => {
        const flow = get().activeShieldFlow;
        return flow ? deserializeShieldFlow(flow) : null;
      },

      getActiveDepositFlow: () => {
        const flow = get().activeDepositFlow;
        return flow ? deserializeDepositFlow(flow) : null;
      },
    }),
    {
      name: 'zkzkp2p-flows',
      // Keep history limited
      partialize: (state) => ({
        activeShieldFlow: state.activeShieldFlow,
        activeDepositFlow: state.activeDepositFlow,
        completedFlows: state.completedFlows.slice(-10), // Keep last 10
      }),
    }
  )
);

// ==================== SELECTORS ====================

export const selectHasActiveFlow = (state: FlowState) =>
  state.activeShieldFlow !== null || state.activeDepositFlow !== null;

export const selectActiveFlowType = (state: FlowState): 'shield' | 'deposit' | null => {
  if (state.activeShieldFlow) return 'shield';
  if (state.activeDepositFlow) return 'deposit';
  return null;
};
