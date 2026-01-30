/**
 * Flow State Store
 * Manages shield and deposit flows with localStorage persistence for recovery
 * Updated for Substance Labs bridge integration
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { BridgeFlowState, BridgeStatus, BridgeDirection } from '../lib/bridge/types';

// ==================== SERIALIZABLE STATE ====================

// Store bigints as strings for JSON serialization
interface SerializedBridgeFlow {
  direction: BridgeDirection;
  status: BridgeStatus;
  orderId?: string;
  amount: string; // bigint as string
  secret?: {
    value: string;
    hash: string;
  };
  txHashes: {
    open?: string;
    fill?: string;
    claim?: string;
    refund?: string;
  };
  // Additional context for zkp2p
  zkp2pDepositId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;

  // Burner info for privacy-preserving deposits
  burner?: {
    nonce: number;             // Timestamp nonce (minute precision)
    smartAccountAddress: string;
    eoaAddress: string;
  };
}

// ==================== STORE STATE ====================

interface FlowState {
  // Active flows (one of each type at a time)
  activeShieldFlow: SerializedBridgeFlow | null;  // base_to_aztec
  activeDepositFlow: SerializedBridgeFlow | null; // aztec_to_base

  // Flow history (completed or failed)
  completedFlows: SerializedBridgeFlow[];

  // UI state
  isExecuting: boolean;

  // Actions
  startShieldFlow: (flow: BridgeFlowState) => void;
  updateShieldFlow: (updates: Partial<BridgeFlowState>) => void;
  completeShieldFlow: () => void;
  failShieldFlow: (error: string) => void;

  startDepositFlow: (flow: BridgeFlowState & { zkp2pDepositId?: string }) => void;
  updateDepositFlow: (updates: Partial<BridgeFlowState> & { zkp2pDepositId?: string }) => void;
  completeDepositFlow: () => void;
  failDepositFlow: (error: string) => void;

  setExecuting: (executing: boolean) => void;
  clearActiveFlows: () => void;

  // Recovery helpers
  getActiveShieldFlow: () => (BridgeFlowState & { direction: BridgeDirection }) | null;
  getActiveDepositFlow: () => (BridgeFlowState & { direction: BridgeDirection; zkp2pDepositId?: string }) | null;
}

// ==================== SERIALIZATION HELPERS ====================

function serializeBridgeFlow(
  flow: BridgeFlowState,
  direction: BridgeDirection,
  extra?: { zkp2pDepositId?: string }
): SerializedBridgeFlow {
  return {
    direction,
    status: flow.status,
    orderId: flow.orderId,
    amount: flow.amount.toString(),
    secret: flow.secret,
    txHashes: flow.txHashes,
    zkp2pDepositId: extra?.zkp2pDepositId,
    error: flow.error,
    createdAt: flow.createdAt || Date.now(),
    updatedAt: Date.now(),
    burner: flow.burner,
  };
}

function deserializeBridgeFlow(flow: SerializedBridgeFlow): BridgeFlowState & { direction: BridgeDirection; zkp2pDepositId?: string } {
  return {
    direction: flow.direction,
    status: flow.status,
    orderId: flow.orderId,
    amount: BigInt(flow.amount),
    secret: flow.secret,
    txHashes: flow.txHashes,
    zkp2pDepositId: flow.zkp2pDepositId,
    error: flow.error,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    burner: flow.burner,
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

      // Shield flow actions (Base → Aztec)
      startShieldFlow: (flow: BridgeFlowState) => {
        set({
          activeShieldFlow: serializeBridgeFlow(flow, 'base_to_aztec'),
          isExecuting: true,
        });
      },

      updateShieldFlow: (updates: Partial<BridgeFlowState>) => {
        const current = get().activeShieldFlow;
        if (!current) return;

        const currentFlow = deserializeBridgeFlow(current);
        const updatedFlow: BridgeFlowState = {
          status: updates.status ?? currentFlow.status,
          orderId: updates.orderId ?? currentFlow.orderId,
          amount: updates.amount ?? currentFlow.amount,
          secret: updates.secret ?? currentFlow.secret,
          txHashes: { ...currentFlow.txHashes, ...updates.txHashes },
          error: updates.error ?? currentFlow.error,
          createdAt: currentFlow.createdAt,
          updatedAt: Date.now(),
        };
        set({
          activeShieldFlow: serializeBridgeFlow(updatedFlow, 'base_to_aztec'),
        });
      },

      completeShieldFlow: () => {
        const current = get().activeShieldFlow;
        if (current) {
          set((state) => ({
            activeShieldFlow: null,
            completedFlows: [...state.completedFlows, { ...current, status: 'completed' as BridgeStatus, updatedAt: Date.now() }],
            isExecuting: false,
          }));
        }
      },

      failShieldFlow: (error: string) => {
        const current = get().activeShieldFlow;
        if (current) {
          set({
            activeShieldFlow: { ...current, status: 'error' as BridgeStatus, error, updatedAt: Date.now() },
            isExecuting: false,
          });
        }
      },

      // Deposit flow actions (Aztec → Base)
      startDepositFlow: (flow: BridgeFlowState & { zkp2pDepositId?: string }) => {
        set({
          activeDepositFlow: serializeBridgeFlow(flow, 'aztec_to_base', { zkp2pDepositId: flow.zkp2pDepositId }),
          isExecuting: true,
        });
      },

      updateDepositFlow: (updates: Partial<BridgeFlowState> & { zkp2pDepositId?: string }) => {
        const current = get().activeDepositFlow;
        if (!current) return;

        const currentFlow = deserializeBridgeFlow(current);
        const updatedFlow: BridgeFlowState = {
          status: updates.status ?? currentFlow.status,
          orderId: updates.orderId ?? currentFlow.orderId,
          amount: updates.amount ?? currentFlow.amount,
          secret: updates.secret ?? currentFlow.secret,
          txHashes: { ...currentFlow.txHashes, ...updates.txHashes },
          error: updates.error ?? currentFlow.error,
          createdAt: currentFlow.createdAt,
          updatedAt: Date.now(),
        };
        set({
          activeDepositFlow: serializeBridgeFlow(updatedFlow, 'aztec_to_base', {
            zkp2pDepositId: updates.zkp2pDepositId ?? currentFlow.zkp2pDepositId,
          }),
        });
      },

      completeDepositFlow: () => {
        const current = get().activeDepositFlow;
        if (current) {
          set((state) => ({
            activeDepositFlow: null,
            completedFlows: [...state.completedFlows, { ...current, status: 'completed' as BridgeStatus, updatedAt: Date.now() }],
            isExecuting: false,
          }));
        }
      },

      failDepositFlow: (error: string) => {
        const current = get().activeDepositFlow;
        if (current) {
          set({
            activeDepositFlow: { ...current, status: 'error' as BridgeStatus, error, updatedAt: Date.now() },
            isExecuting: false,
          });
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
        return flow ? deserializeBridgeFlow(flow) : null;
      },

      getActiveDepositFlow: () => {
        const flow = get().activeDepositFlow;
        return flow ? deserializeBridgeFlow(flow) : null;
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
