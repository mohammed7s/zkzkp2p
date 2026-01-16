'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { useWalletStore } from '@/stores/walletStore';
import { useFlowStore } from '@/stores/flowStore';
import {
  createBridge,
  executeDeposit,
  formatTokenAmount,
  parseTokenAmount,
  TIMING,
  isConfigured,
} from '@/lib/bridge';
import type { BridgeFlowState, BridgeStatus } from '@/lib/bridge/types';
import { createZkp2pDeposit } from '@/lib/zkp2p/client';
import { ZKP2P } from '@/config';

interface CreateDepositProps {
  privateBalance: bigint;
  onRefreshBalances: (force?: boolean) => void;
}

const PAYMENT_METHODS = ZKP2P.paymentMethods;
const CURRENCIES = ZKP2P.currencies;

// Deposit flow stages (Substance bridge flow)
type DepositStage =
  | 'idle'
  | 'opening'           // Opening order on Aztec
  | 'waiting_filler'    // Waiting for filler to fill on Base
  | 'claiming'          // Claiming/settling the order
  | 'depositing_zkp2p'  // Creating zkp2p deposit
  | 'complete'
  | 'error';

const STAGE_LABELS: Record<DepositStage, string> = {
  idle: '',
  opening: 'open order on aztec',
  waiting_filler: 'waiting for filler',
  claiming: 'claiming on base',
  depositing_zkp2p: 'create zkp2p deposit',
  complete: 'complete',
  error: 'failed',
};

const STAGE_DETAILS: Record<DepositStage, string> = {
  idle: '',
  opening: 'confirm in azguard wallet...',
  waiting_filler: 'filler will bridge funds to base (up to 5 min)',
  claiming: 'finalizing bridge settlement...',
  depositing_zkp2p: 'approve usdc + create zkp2p deposit...',
  complete: 'your deposit is live on zkp2p!',
  error: 'see error below',
};

export function CreateDeposit({ privateBalance, onRefreshBalances }: CreateDepositProps) {
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<typeof PAYMENT_METHODS[number]>('revolut');
  const [currency, setCurrency] = useState<typeof CURRENCIES[number]>('USD');
  const [paymentTag, setPaymentTag] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<DepositStage>('idle');
  const [openTxHash, setOpenTxHash] = useState<string | null>(null);
  const [baseTxHash, setBaseTxHash] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [waitingTime, setWaitingTime] = useState(0);
  const [hasActiveFlow, setHasActiveFlow] = useState(false);

  const flowRef = useRef<BridgeFlowState | null>(null);
  const waitingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Flow store for persistence
  const {
    activeDepositFlow,
    startDepositFlow,
    updateDepositFlow,
    completeDepositFlow,
    failDepositFlow,
    getActiveDepositFlow,
    clearActiveFlows,
  } = useFlowStore();

  // Check for active flow on mount (recovery)
  useEffect(() => {
    const savedFlow = getActiveDepositFlow();
    if (savedFlow && savedFlow.status !== 'completed' && savedFlow.status !== 'error') {
      console.log('[Deposit] Found active flow to recover:', savedFlow.orderId, savedFlow.status);
      setHasActiveFlow(true);
      flowRef.current = savedFlow;
      setOrderId(savedFlow.orderId || null);
      if (savedFlow.txHashes?.open) setOpenTxHash(savedFlow.txHashes.open);
      if (savedFlow.txHashes?.claim) setBaseTxHash(savedFlow.txHashes.claim);

      // Map flow status to UI stage
      const statusToStage: Record<BridgeStatus, DepositStage> = {
        'idle': 'idle',
        'approving': 'opening',
        'opening': 'opening',
        'waiting_filler': 'waiting_filler',
        'claiming': 'claiming',
        'completed': 'complete',
        'refunding': 'error',
        'refunded': 'error',
        'error': 'error',
      };
      const recoveredStage = statusToStage[savedFlow.status] || 'idle';
      if (recoveredStage !== 'idle') {
        setStage(recoveredStage);
      }
    }
  }, [getActiveDepositFlow]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (waitingTimerRef.current) {
        clearInterval(waitingTimerRef.current);
      }
    };
  }, []);

  // Clear stale state when stage becomes idle
  useEffect(() => {
    if (stage === 'idle') {
      setOpenTxHash(null);
      setBaseTxHash(null);
      setOrderId(null);
      setError(null);
      setWaitingTime(0);
      setHasActiveFlow(false);
    }
  }, [stage]);

  // Handler to dismiss/abandon recovered flow
  const handleDismissRecovery = useCallback(() => {
    console.log('[Deposit] User dismissed recovery - clearing active flow');
    clearActiveFlows();
    flowRef.current = null;
    setHasActiveFlow(false);
    setStage('idle');
  }, [clearActiveFlows]);

  const { address: evmAddress } = useAccount();
  const { aztecCaipAccount, azguardClient, setAztecTxPending } = useWalletStore();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const amountBigInt = amount ? parseTokenAmount(amount) : 0n;
  const hasEnoughBalance = privateBalance >= amountBigInt;
  const canCreate = amount && hasEnoughBalance && evmAddress && walletClient;

  // Check if bridge is configured
  const bridgeConfigured = isConfigured();

  const handleCreate = async () => {
    if (!azguardClient || !aztecCaipAccount || !evmAddress || !walletClient || !publicClient) {
      setError('wallets not connected - connect both aztec and base wallets');
      return;
    }

    if (!amount || amountBigInt <= 0n) {
      setError('enter an amount');
      return;
    }

    if (!hasEnoughBalance) {
      setError('insufficient balance - fund your account first');
      return;
    }

    if (!paymentTag.trim()) {
      setError('enter your payment tag');
      return;
    }

    if (!bridgeConfigured) {
      setError('bridge not configured - check token addresses in .env');
      return;
    }

    setIsCreating(true);
    setError(null);
    setOpenTxHash(null);
    setBaseTxHash(null);
    setOrderId(null);
    setWaitingTime(0);

    // Pause balance polling during Aztec txs (Azguard has IDB concurrency issues)
    setAztecTxPending(true);

    // Clear any existing timer
    if (waitingTimerRef.current) {
      clearInterval(waitingTimerRef.current);
      waitingTimerRef.current = null;
    }

    try {
      // Initialize bridge with Azguard client
      console.log('[Deposit] Creating bridge instance...');
      const bridge = await createBridge({
        azguardClient,
        evmProvider: walletClient,
      });

      // Create initial flow state for persistence
      const initialFlow: BridgeFlowState = {
        status: 'opening',
        amount: amountBigInt,
        txHashes: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      flowRef.current = initialFlow;
      startDepositFlow(initialFlow);
      console.log('[Deposit] Flow persisted to storage');

      // Execute deposit flow (Aztec -> Base)
      setStage('opening');
      console.log('[Deposit] Executing deposit flow...');

      // Start waiting timer when we reach waiting_filler stage
      const onProgress = (state: Partial<BridgeFlowState>) => {
        console.log('[Deposit] Progress:', state.status);

        if (state.status) {
          // Map BridgeStatus to DepositStage
          const statusToStage: Record<BridgeStatus, DepositStage> = {
            'idle': 'idle',
            'approving': 'opening',
            'opening': 'opening',
            'waiting_filler': 'waiting_filler',
            'claiming': 'claiming',
            'completed': 'complete',
            'refunding': 'error',
            'refunded': 'error',
            'error': 'error',
          };
          setStage(statusToStage[state.status] || 'opening');
        }

        if (state.orderId) {
          setOrderId(state.orderId);
        }

        if (state.txHashes?.open) {
          setOpenTxHash(state.txHashes.open);
        }

        if (state.txHashes?.fill || state.txHashes?.claim) {
          setBaseTxHash(state.txHashes.fill || state.txHashes.claim || null);
        }

        // Start timer when waiting for filler
        if (state.status === 'waiting_filler' && !waitingTimerRef.current) {
          waitingTimerRef.current = setInterval(() => {
            setWaitingTime(prev => prev + 1);
          }, 1000);
        }

        // Update store
        updateDepositFlow({
          status: state.status,
          orderId: state.orderId,
          txHashes: state.txHashes,
        });
      };

      const result = await executeDeposit({
        bridge,
        amount: amountBigInt,
        recipientAddress: evmAddress,
        onProgress,
      });

      console.log('[Deposit] Bridge complete:', result);

      // Stop timer
      if (waitingTimerRef.current) {
        clearInterval(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }

      // Refresh balances after bridge completes
      onRefreshBalances(true);

      // Step 2: Create zkp2p deposit
      setStage('depositing_zkp2p');
      updateDepositFlow({ status: 'claiming' }); // Use claiming as proxy for zkp2p stage
      console.log('[Deposit] Creating zkp2p deposit...');

      // Calculate min/max intent amounts (e.g., 10% to 100% of deposit)
      const minIntent = amountBigInt / 10n; // 10% minimum
      const maxIntent = amountBigInt; // 100% maximum

      const zkp2pResult = await createZkp2pDeposit({
        walletClient,
        amount: amountBigInt,
        minIntentAmount: minIntent,
        maxIntentAmount: maxIntent,
        paymentMethod,
        paymentTag,
        currency,
      });

      console.log('[Deposit] zkp2p deposit created:', zkp2pResult);
      setBaseTxHash(zkp2pResult.hash);

      // Success!
      console.log('[Deposit] ===== ALL STEPS COMPLETE =====');
      setStage('complete');
      completeDepositFlow();

      // Reset after showing success
      setTimeout(() => {
        setStage('idle');
        setAmount('');
        setPaymentTag('');
        setOpenTxHash(null);
        setBaseTxHash(null);
        setOrderId(null);
        setWaitingTime(0);
        flowRef.current = null;
        onRefreshBalances();
      }, 3000);

    } catch (err) {
      console.error('[Deposit] Error:', err);
      const errorMessage = err instanceof Error ? err.message : 'failed to create deposit';
      setError(errorMessage);
      setStage('error');
      failDepositFlow(errorMessage);

      // Clear timer on error
      if (waitingTimerRef.current) {
        clearInterval(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }
    } finally {
      setIsCreating(false);
      // Resume balance polling
      setAztecTxPending(false);
    }
  };

  return (
    <div className="border border-gray-800 p-6 space-y-6">
      <div className="text-sm text-gray-500 uppercase tracking-wide">create deposit privately</div>

      {/* Active Flow Recovery Banner */}
      {hasActiveFlow && flowRef.current && (
        <div className="border border-yellow-600 bg-yellow-900/20 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-yellow-500 text-lg">!</span>
            <span className="text-yellow-400 font-medium">Active deposit found</span>
          </div>
          <div className="text-xs text-gray-400 space-y-1">
            <div>Order ID: <span className="text-white font-mono">{flowRef.current.orderId || 'pending'}</span></div>
            <div>Amount: <span className="text-white">{formatTokenAmount(flowRef.current.amount)} USDC</span></div>
            <div>Status: <span className="text-yellow-400">{stage}</span></div>
            {openTxHash && <div>Open TX: <span className="text-white font-mono text-xs">{openTxHash.slice(0, 10)}...</span></div>}
          </div>
          <div className="text-xs text-gray-500">
            Your previous deposit is still in progress.
            You can continue or abandon this flow.
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleDismissRecovery}
              className="flex-1 py-2 text-xs border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition-colors"
            >
              abandon flow
            </button>
            <button
              onClick={() => setHasActiveFlow(false)}
              className="flex-1 py-2 text-xs border border-yellow-700 text-yellow-400 hover:border-yellow-500 hover:text-yellow-300 transition-colors"
            >
              continue flow
            </button>
          </div>
        </div>
      )}

      {/* Bridge Status */}
      {!bridgeConfigured && (
        <div className="text-xs text-yellow-600 border border-yellow-800 p-2">
          bridge not configured - check token addresses
        </div>
      )}

      {/* Available Balance */}
      <div className="flex justify-between text-xs text-gray-500 border-b border-gray-800 pb-2">
        <span>available (private)</span>
        <span className="text-white">{formatTokenAmount(privateBalance)} USDC</span>
      </div>

      {/* Amount */}
      <div className="space-y-2">
        <label className="text-xs text-gray-600">sell</label>
        <div className="flex border border-gray-800 focus-within:border-gray-600">
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent px-3 py-2 outline-none text-white"
            disabled={isCreating}
          />
          <button
            onClick={() => setAmount(formatTokenAmount(privateBalance).split('.')[0])}
            className="px-2 text-xs text-gray-600 hover:text-gray-400"
            disabled={isCreating}
          >
            max
          </button>
          <div className="px-3 py-2 border-l border-gray-800 text-gray-500">USDC</div>
        </div>
        {amount && !hasEnoughBalance && (
          <p className="text-xs text-red-500">insufficient balance</p>
        )}
      </div>

      {/* Payment Method */}
      <div className="space-y-2">
        <label className="text-xs text-gray-600">via</label>
        <div className="flex gap-2">
          {PAYMENT_METHODS.map((method) => (
            <button
              key={method}
              onClick={() => setPaymentMethod(method)}
              disabled={isCreating}
              className={`flex-1 py-2 text-sm border transition-colors ${
                paymentMethod === method
                  ? 'border-gray-400 text-white'
                  : 'border-gray-800 text-gray-600 hover:border-gray-700'
              } disabled:opacity-50`}
            >
              {method}
            </button>
          ))}
        </div>
      </div>

      {/* Currency */}
      <div className="space-y-2">
        <label className="text-xs text-gray-600">receive</label>
        <div className="flex gap-2">
          {CURRENCIES.map((curr) => (
            <button
              key={curr}
              onClick={() => setCurrency(curr)}
              disabled={isCreating}
              className={`flex-1 py-2 text-sm border transition-colors ${
                currency === curr
                  ? 'border-gray-400 text-white'
                  : 'border-gray-800 text-gray-600 hover:border-gray-700'
              } disabled:opacity-50`}
            >
              {curr}
            </button>
          ))}
        </div>
      </div>

      {/* Payment Tag */}
      <div className="space-y-2">
        <label className="text-xs text-gray-600">
          {paymentMethod === 'revolut' ? 'revtag' : paymentMethod === 'venmo' ? 'venmo username' : 'email'}
        </label>
        <input
          type="text"
          value={paymentTag}
          onChange={(e) => setPaymentTag(e.target.value)}
          placeholder={paymentMethod === 'revolut' ? '@username' : 'you@example.com'}
          className="w-full bg-transparent px-3 py-2 border border-gray-800 focus:border-gray-600 outline-none"
          disabled={isCreating}
        />
      </div>

      {/* Status Stages */}
      {stage !== 'idle' && stage !== 'error' && (
        <div className="border border-gray-800 p-4 space-y-3">
          <div className="flex justify-between items-center">
            <div className="text-xs text-gray-500 uppercase">deposit progress</div>
            {orderId && (
              <div className="text-xs text-gray-600 font-mono">
                order: {orderId.slice(0, 8)}...
              </div>
            )}
          </div>

          <div className="space-y-2">
            {(['opening', 'waiting_filler', 'claiming', 'depositing_zkp2p', 'complete'] as const).map((s) => {
              const stages = ['opening', 'waiting_filler', 'claiming', 'depositing_zkp2p', 'complete'];
              const currentIdx = stages.indexOf(stage);
              const stageIdx = stages.indexOf(s);
              const isActive = s === stage;
              const isComplete = stageIdx < currentIdx || stage === 'complete';

              return (
                <div key={s} className="flex items-center gap-2 text-xs">
                  <span className={`w-4 h-4 flex items-center justify-center border ${
                    isComplete ? 'border-green-600 text-green-500' :
                    isActive ? 'border-yellow-600 text-yellow-500 animate-pulse' :
                    'border-gray-800 text-gray-700'
                  }`}>
                    {isComplete ? '✓' : isActive ? '→' : stageIdx + 1}
                  </span>
                  <span className={
                    isComplete ? 'text-green-500' :
                    isActive ? 'text-white' :
                    'text-gray-700'
                  }>
                    {STAGE_LABELS[s]}
                    {isActive && s === 'waiting_filler' && waitingTime > 0 && (
                      <span className="text-gray-500 ml-2">({waitingTime}s)</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Current Stage Details */}
          {STAGE_DETAILS[stage] && (
            <div className="text-xs text-yellow-600 pt-2 border-t border-gray-800">
              {STAGE_DETAILS[stage]}
            </div>
          )}

          {/* Transaction Hashes */}
          {(openTxHash || baseTxHash) && (
            <div className="text-xs text-gray-600 pt-2 border-t border-gray-800 space-y-1">
              {openTxHash && (
                <div>aztec tx: <a href={`https://devnet.aztecscan.xyz/tx-effects/${openTxHash}`} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline">{openTxHash.slice(0, 10)}...{openTxHash.slice(-8)}</a></div>
              )}
              {baseTxHash && (
                <div>base tx: <a href={`https://sepolia.basescan.org/tx/${baseTxHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{baseTxHash.slice(0, 10)}...{baseTxHash.slice(-8)}</a></div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="border border-red-900 p-3 space-y-2">
          <div className="text-sm text-red-500">{error}</div>
          {orderId && (
            <div className="text-xs text-gray-600">
              order ID: <span className="font-mono">{orderId}</span>
            </div>
          )}
          {openTxHash && (
            <div className="text-xs text-gray-600">
              aztec tx: <a href={`https://devnet.aztecscan.xyz/tx-effects/${openTxHash}`} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline font-mono">{openTxHash.slice(0, 16)}...</a>
            </div>
          )}
          {baseTxHash && (
            <div className="text-xs text-gray-600">
              base tx: <a href={`https://sepolia.basescan.org/tx/${baseTxHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline font-mono">{baseTxHash.slice(0, 16)}...</a>
            </div>
          )}
          <button
            onClick={() => setStage('idle')}
            className="text-xs text-gray-500 hover:text-white border border-gray-700 hover:border-gray-500 px-2 py-1 mt-2"
          >
            try again
          </button>
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleCreate}
        disabled={isCreating || !amount || !hasEnoughBalance || !evmAddress}
        className="w-full py-3 border border-gray-600 hover:border-white hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {isCreating ? 'creating...' : 'create deposit'}
      </button>

      {/* Wallet Connection Warning */}
      {!evmAddress && (
        <p className="text-xs text-yellow-600">connect base wallet to create deposits</p>
      )}

      {/* Info */}
      <div className="text-xs text-gray-700 space-y-1">
        <p>deposits are escrowed on zkp2p until a buyer completes payment</p>
      </div>
    </div>
  );
}
