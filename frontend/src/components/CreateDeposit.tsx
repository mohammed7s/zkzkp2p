'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { useWalletStore } from '@/stores/walletStore';
import { useFlowStore } from '@/stores/flowStore';
import {
  parseAmount,
  initDepositFlow,
  setAuthwit,
  lockOnAztec,
  transferToPublic,
  type DepositFlowState,
} from '@/lib/train/deposit';
import { redeemOnBase, isHTLCPending, getHTLCDetails, notifySolver, formatTokenAmount } from '@/lib/train/evm';
import { createZkp2pDeposit, USDC_ADDRESS } from '@/lib/zkp2p/client';
import { SOLVER_AZTEC_ADDRESS, SOLVER_EVM_ADDRESS } from '@/lib/train/contracts';
import { TIMING, ZKP2P, isSolverConfigured } from '@/config';

interface CreateDepositProps {
  privateBalance: bigint;
  onRefreshBalances: (force?: boolean) => void;
}

const PAYMENT_METHODS = ZKP2P.paymentMethods;
const CURRENCIES = ZKP2P.currencies;

// Deposit flow stages
type DepositStage =
  | 'idle'
  | 'transferring_public' // Moving tokens from private to public
  | 'creating_intent'     // Locking on Aztec
  | 'waiting_solver'      // Waiting for solver to lock on Base
  | 'redeeming_base'      // User redeeming on Base
  | 'depositing_zkp2p'    // Creating zkp2p deposit
  | 'complete'
  | 'error';

const STAGE_LABELS: Record<DepositStage, string> = {
  idle: '',
  transferring_public: 'transfer private → public',
  creating_intent: 'lock on aztec (htlc)',
  waiting_solver: 'waiting for solver lock on base',
  redeeming_base: 'redeem on base',
  depositing_zkp2p: 'create zkp2p deposit',
  complete: 'complete',
  error: 'failed',
};

const STAGE_DETAILS: Record<DepositStage, string> = {
  idle: '',
  transferring_public: 'confirm in azguard wallet...',
  creating_intent: 'confirm authwit + lock in azguard...',
  waiting_solver: 'solver will lock matching htlc on base (up to 5 min)',
  redeeming_base: 'confirm in metamask to receive usdc on base...',
  depositing_zkp2p: 'approve usdc + create zkp2p deposit...',
  complete: 'your deposit is live on zkp2p!',
  error: 'see error below',
};

// Use centralized timing config
const SOLVER_POLL_INTERVAL = TIMING.solverPollInterval;
const SOLVER_MAX_WAIT = TIMING.solverMaxWait;

export function CreateDeposit({ privateBalance, onRefreshBalances }: CreateDepositProps) {
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<typeof PAYMENT_METHODS[number]>('revolut');
  const [currency, setCurrency] = useState<typeof CURRENCIES[number]>('USD');
  const [paymentTag, setPaymentTag] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<DepositStage>('idle');
  const [aztecTxHash, setAztecTxHash] = useState<string | null>(null);
  const [baseTxHash, setBaseTxHash] = useState<string | null>(null);
  const [swapId, setSwapId] = useState<string | null>(null);
  const [waitingTime, setWaitingTime] = useState(0);
  const [hasActiveFlow, setHasActiveFlow] = useState(false);

  const flowRef = useRef<DepositFlowState | null>(null);
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
    if (savedFlow && savedFlow.status !== 'COMPLETE' && savedFlow.status !== 'ERROR') {
      console.log('[Deposit] Found active flow to recover:', savedFlow.swapId, savedFlow.status);
      setHasActiveFlow(true);
      flowRef.current = savedFlow;
      setSwapId(savedFlow.swapId);
      if (savedFlow.aztecLockTxHash) setAztecTxHash(savedFlow.aztecLockTxHash);
      if (savedFlow.evmLockTxHash) setBaseTxHash(savedFlow.evmLockTxHash);

      // Map flow status to UI stage
      const statusToStage: Record<string, DepositStage> = {
        'GENERATING_SECRET': 'creating_intent',
        'SETTING_AUTHWIT': 'creating_intent',
        'LOCKING_AZTEC': 'creating_intent',
        'WAITING_SOLVER': 'waiting_solver',
        'REDEEMING_BASE': 'redeeming_base',
        'CREATING_DEPOSIT': 'depositing_zkp2p',
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
      setAztecTxHash(null);
      setBaseTxHash(null);
      setSwapId(null);
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

  const amountBigInt = amount ? parseAmount(amount) : 0n;
  const hasEnoughBalance = privateBalance >= amountBigInt;
  const canCreate = amount && hasEnoughBalance && evmAddress && walletClient;

  // Check if solver is configured (use centralized config)
  const solverConfigured = isSolverConfigured();

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

    if (!solverConfigured) {
      setError('solver not configured - check NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS');
      return;
    }

    setIsCreating(true);
    setError(null);
    setAztecTxHash(null);
    setBaseTxHash(null);
    setSwapId(null);
    setWaitingTime(0);

    // Pause balance polling during Aztec txs (Azguard has IDB concurrency issues)
    setAztecTxPending(true);

    // Clear any existing timer
    if (waitingTimerRef.current) {
      clearInterval(waitingTimerRef.current);
      waitingTimerRef.current = null;
    }

    try {
      // Step 0: Initialize deposit flow
      console.log('[Deposit] Initializing flow...');
      const flow = await initDepositFlow(amountBigInt);
      flowRef.current = flow;
      setSwapId(flow.swapId);
      console.log('[Deposit] Swap ID:', flow.swapId);

      // CRITICAL: Persist flow immediately to prevent secret loss on refresh
      startDepositFlow(flow);
      console.log('[Deposit] Flow persisted to storage');

      // Step 1: Transfer from private to public (if needed)
      setStage('transferring_public');
      console.log('[Deposit] Step 1: Transferring to public balance...');
      try {
        const transferTx = await transferToPublic(azguardClient, aztecCaipAccount, amountBigInt);
        console.log('[Deposit] Step 1 COMPLETE: transfer_to_public tx:', transferTx);
        // Refresh balances after transfer (force=true to bypass pending check)
        onRefreshBalances(true);
      } catch (e) {
        console.log('[Deposit] Step 1 SKIPPED: Transfer to public failed (may already be in public balance)', e);
        // May already be in public balance - continue anyway
      }

      // Step 2: Set authwit for Train contract
      console.log('[Deposit] Step 2: Setting authwit...');
      const authwitResult = await setAuthwit(azguardClient, aztecCaipAccount, amountBigInt);
      console.log('[Deposit] Step 2 COMPLETE: authwit result:', authwitResult);

      // Step 3: Lock on Aztec
      setStage('creating_intent');
      console.log('[Deposit] Step 3: Locking on Aztec...');
      const aztecLockTxHash = await lockOnAztec(
        azguardClient,
        aztecCaipAccount,
        SOLVER_AZTEC_ADDRESS,
        flow,
        evmAddress,
        authwitResult, // Pass authwit result to handle inline if needed
      );
      console.log('[Deposit] Step 3 COMPLETE: Aztec lock tx:', aztecLockTxHash);
      setAztecTxHash(aztecLockTxHash);
      // Update store with Aztec lock hash
      updateDepositFlow({ status: 'LOCKING_AZTEC', aztecLockTxHash });
      // Refresh balances after lock (force=true to bypass pending check)
      onRefreshBalances(true);

      // Notify solver for faster processing (non-blocking)
      notifySolver({
        swapId: flow.swapId,
        direction: 'aztec_to_base',
        amount: flow.amount,
        hashlockHigh: flow.hashlockHigh,
        hashlockLow: flow.hashlockLow,
        userAddress: evmAddress,
      }).catch(() => {}); // Ignore errors - solver will detect via events

      // Step 4: Wait for solver to lock on Base
      setStage('waiting_solver');
      updateDepositFlow({ status: 'WAITING_SOLVER' });
      console.log('[Deposit] Step 4: Waiting for solver to lock on Base...');
      console.log('[Deposit] Swap ID for solver:', flow.swapId);

      // Start timer to show elapsed waiting time
      waitingTimerRef.current = setInterval(() => {
        setWaitingTime(prev => prev + 1);
      }, 1000);

      const solverLockFound = await pollForSolverLock(
        publicClient,
        BigInt(flow.swapId),
      );

      // Stop timer
      if (waitingTimerRef.current) {
        clearInterval(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }

      if (!solverLockFound) {
        console.log('[Deposit] Step 4 FAILED: Solver did not lock on Base in time');
        throw new Error(`Solver did not respond in time (waited ${Math.floor(SOLVER_MAX_WAIT / 1000)}s). Your Aztec HTLC is still active - you can refund after timelock expires.`);
      }
      console.log('[Deposit] Step 4 COMPLETE: Solver lock detected on Base!');

      // Step 5: Redeem on Base
      setStage('redeeming_base');
      updateDepositFlow({ status: 'REDEEMING_BASE' });
      console.log('[Deposit] Step 5: Redeeming on Base...');
      const redeemTx = await redeemOnBase(
        walletClient,
        publicClient,
        BigInt(flow.swapId),
        flow.secretHigh,
        flow.secretLow,
      );
      console.log('[Deposit] Step 5 COMPLETE: Base redeem tx:', redeemTx);
      setBaseTxHash(redeemTx);
      updateDepositFlow({ evmRedeemTxHash: redeemTx });

      // Step 6: Create zkp2p deposit
      setStage('depositing_zkp2p');
      updateDepositFlow({ status: 'CREATING_DEPOSIT' });
      console.log('[Deposit] Step 6: Creating zkp2p deposit...');

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

      console.log('[Deposit] Step 6 COMPLETE: zkp2p deposit created:', zkp2pResult);
      setBaseTxHash(zkp2pResult.hash);

      // Success!
      console.log('[Deposit] ===== ALL STEPS COMPLETE =====');
      setStage('complete');
      completeDepositFlow(); // Mark as complete in store

      // Reset after showing success
      setTimeout(() => {
        setStage('idle');
        setAmount('');
        setPaymentTag('');
        setAztecTxHash(null);
        setBaseTxHash(null);
        setSwapId(null);
        setWaitingTime(0);
        flowRef.current = null;
        onRefreshBalances();
      }, 3000);

    } catch (err) {
      console.error('[Deposit] Error:', err);
      const errorMessage = err instanceof Error ? err.message : 'failed to create deposit';
      setError(errorMessage);
      setStage('error');
      failDepositFlow(errorMessage); // Mark as failed in store (keeps flow for recovery)

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
            <span className="text-yellow-500 text-lg">⚠️</span>
            <span className="text-yellow-400 font-medium">Active deposit found</span>
          </div>
          <div className="text-xs text-gray-400 space-y-1">
            <div>Swap ID: <span className="text-white font-mono">{flowRef.current.swapId}</span></div>
            <div>Amount: <span className="text-white">{formatTokenAmount(flowRef.current.amount)} USDC</span></div>
            <div>Status: <span className="text-yellow-400">{stage}</span></div>
            {aztecTxHash && <div>Aztec TX: <span className="text-white font-mono text-xs">{aztecTxHash.slice(0, 10)}...</span></div>}
          </div>
          <div className="text-xs text-gray-500">
            Your previous deposit is still in progress. The secrets are saved locally.
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

      {/* Solver Status */}
      {!solverConfigured && (
        <div className="text-xs text-yellow-600 border border-yellow-800 p-2">
          solver not configured - deposits are simulated
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
            {swapId && (
              <div className="text-xs text-gray-600 font-mono">
                swap: {swapId.slice(0, 8)}...
              </div>
            )}
          </div>

          <div className="space-y-2">
            {(['transferring_public', 'creating_intent', 'waiting_solver', 'redeeming_base', 'depositing_zkp2p', 'complete'] as const).map((s) => {
              const stages = ['transferring_public', 'creating_intent', 'waiting_solver', 'redeeming_base', 'depositing_zkp2p', 'complete'];
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
                    {isActive && s === 'waiting_solver' && waitingTime > 0 && (
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
          {(aztecTxHash || baseTxHash) && (
            <div className="text-xs text-gray-600 pt-2 border-t border-gray-800 space-y-1">
              {aztecTxHash && (
                <div>aztec tx: <a href={`https://devnet.aztecscan.xyz/tx-effects/${aztecTxHash}`} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline">{aztecTxHash.slice(0, 10)}...{aztecTxHash.slice(-8)}</a></div>
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
          {swapId && (
            <div className="text-xs text-gray-600">
              swap ID: <span className="font-mono">{swapId}</span>
            </div>
          )}
          {aztecTxHash && (
            <div className="text-xs text-gray-600">
              aztec tx: <a href={`https://devnet.aztecscan.xyz/tx-effects/${aztecTxHash}`} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline font-mono">{aztecTxHash.slice(0, 16)}...</a>
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

/**
 * Poll for solver lock on Base
 */
async function pollForSolverLock(
  publicClient: any,
  swapId: bigint,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < SOLVER_MAX_WAIT) {
    try {
      const isPending = await isHTLCPending(publicClient, swapId);
      if (isPending) {
        console.log('[Deposit] Solver lock detected!');
        return true;
      }
    } catch (e) {
      console.log('[Deposit] Polling error:', e);
    }

    await new Promise(resolve => setTimeout(resolve, SOLVER_POLL_INTERVAL));
  }

  return false;
}
