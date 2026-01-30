'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { type Hex } from 'viem';
import { useWalletStore } from '@/stores/walletStore';
import { useFlowStore } from '@/stores/flowStore';
import {
  createBridge,
  executeDeposit,
  formatTokenAmount,
  parseTokenAmount,
  isConfigured,
} from '@/lib/bridge';
import type { BridgeFlowState, BridgeStatus } from '@/lib/bridge/types';
import { createZkp2pDeposit } from '@/lib/zkp2p/client';
import { ZKP2P } from '@/config';

// Burner derivation (two-layer: master key + timestamp nonce)
import {
  deriveBurner,
  recoverBurner,
} from '@/lib/burner';

// Paymaster for gasless transactions
import {
  createSponsoredSmartAccountClient,
  getSmartAccountAddress,
  isPaymasterConfigured,
} from '@/lib/paymaster';

interface CreateDepositProps {
  privateBalance: bigint;
  onRefreshBalances: (force?: boolean) => void;
}

const PAYMENT_METHODS = ZKP2P.paymentMethods;
const CURRENCIES = ZKP2P.currencies;

// Deposit flow stages (with burner derivation)
type DepositStage =
  | 'idle'
  | 'deriving_burner'   // Signing to derive burner key
  | 'opening'           // Opening order on Aztec
  | 'waiting_filler'    // Waiting for filler to fill on Base
  | 'claiming'          // Claiming/settling the order
  | 'depositing_zkp2p'  // Creating zkp2p deposit (gasless via paymaster)
  | 'complete'
  | 'error';

const STAGE_LABELS: Record<DepositStage, string> = {
  idle: '',
  deriving_burner: 'derive burner key',
  opening: 'open order on aztec',
  waiting_filler: 'waiting for filler',
  claiming: 'claiming on base',
  depositing_zkp2p: 'create zkp2p deposit',
  complete: 'complete',
  error: 'failed',
};

const STAGE_DETAILS: Record<DepositStage, string> = {
  idle: '',
  deriving_burner: 'sign in metamask to derive one-time burner key...',
  opening: 'confirm in azguard wallet...',
  waiting_filler: 'filler will bridge funds to base (up to 5 min)',
  claiming: 'finalizing bridge settlement...',
  depositing_zkp2p: 'creating zkp2p deposit (gasless)...',
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
  const [burnerAddress, setBurnerAddress] = useState<string | null>(null);

  const flowRef = useRef<BridgeFlowState | null>(null);
  const waitingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const burnerKeyRef = useRef<Hex | null>(null);

  // Flow store for persistence
  const {
    startDepositFlow,
    updateDepositFlow,
    completeDepositFlow,
    failDepositFlow,
    getActiveDepositFlow,
    clearActiveFlows,
    completedFlows,
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
      if (savedFlow.burner?.smartAccountAddress) setBurnerAddress(savedFlow.burner.smartAccountAddress);

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
      setBurnerAddress(null);
      burnerKeyRef.current = null;
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

  // Check if bridge and paymaster are configured
  const bridgeConfigured = isConfigured();
  const paymasterConfigured = isPaymasterConfigured();

  // Handler to recover burner funds
  const handleRecoverBurner = useCallback(async () => {
    const savedFlow = getActiveDepositFlow();
    if (!savedFlow?.burner || !walletClient || !evmAddress) {
      setError('Cannot recover: missing flow or wallet data');
      return;
    }

    try {
      setIsCreating(true);
      setError(null);

      // Re-sign to derive the same burner key using saved nonce
      console.log('[Deposit] Recovering burner key with nonce:', savedFlow.burner.nonce);
      const { privateKey: burnerPrivateKey, eoaAddress } = await recoverBurner(
        walletClient,
        evmAddress,
        savedFlow.burner.nonce
      );

      // Verify it matches
      if (eoaAddress.toLowerCase() !== savedFlow.burner.eoaAddress.toLowerCase()) {
        throw new Error('Recovered address mismatch - are you using the same wallet?');
      }

      burnerKeyRef.current = burnerPrivateKey;
      console.log('[Deposit] Burner recovered:', eoaAddress);

      // Now try to complete the zkp2p deposit
      if (savedFlow.status === 'completed' || savedFlow.status === 'claiming') {
        // Bridge is done, just need to create zkp2p deposit
        setStage('depositing_zkp2p');

        // Create sponsored smart account client
        const smartAccountClient = await createSponsoredSmartAccountClient(burnerPrivateKey);

        // Create zkp2p deposit (gasless)
        const minIntent = savedFlow.amount / 10n;
        const maxIntent = savedFlow.amount;

        const zkp2pResult = await createZkp2pDeposit({
          walletClient: smartAccountClient as any, // Smart account client is compatible
          amount: savedFlow.amount,
          minIntentAmount: minIntent,
          maxIntentAmount: maxIntent,
          paymentMethod,
          paymentTag,
          currency,
        });

        console.log('[Deposit] zkp2p deposit created:', zkp2pResult);
        setBaseTxHash(zkp2pResult.hash);
        setStage('complete');
        completeDepositFlow();

        setTimeout(() => {
          setStage('idle');
          onRefreshBalances();
        }, 3000);
      } else {
        setError('Flow is in an unrecoverable state. Please abandon and try again.');
      }
    } catch (err) {
      console.error('[Deposit] Recovery error:', err);
      setError(err instanceof Error ? err.message : 'Recovery failed');
    } finally {
      setIsCreating(false);
    }
  }, [getActiveDepositFlow, walletClient, evmAddress, paymentMethod, paymentTag, currency, completeDepositFlow, onRefreshBalances]);

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

    if (!paymasterConfigured) {
      setError('paymaster not configured - add NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL to .env');
      return;
    }

    setIsCreating(true);
    setError(null);
    setOpenTxHash(null);
    setBaseTxHash(null);
    setOrderId(null);
    setWaitingTime(0);
    setBurnerAddress(null);

    // Pause balance polling during Aztec txs (Azguard has IDB concurrency issues)
    setAztecTxPending(true);

    // Clear any existing timer
    if (waitingTimerRef.current) {
      clearInterval(waitingTimerRef.current);
      waitingTimerRef.current = null;
    }

    try {
      // ====================================================================
      // Step 1: Derive burner key (master key + timestamp nonce)
      // ====================================================================
      setStage('deriving_burner');
      console.log('[Deposit] Deriving burner key...');

      // deriveBurner prompts for master key signature (if not cached) and generates timestamp nonce
      const { privateKey: burnerPrivateKey, eoaAddress, nonce } = await deriveBurner(
        walletClient,
        evmAddress
      );
      burnerKeyRef.current = burnerPrivateKey;

      // Get the smart account address (deterministic from the private key)
      const smartAccountAddress = await getSmartAccountAddress(burnerPrivateKey);
      setBurnerAddress(smartAccountAddress);

      console.log('[Deposit] Burner derived:', {
        nonce,
        eoaAddress,
        smartAccountAddress,
      });

      // ====================================================================
      // Step 2: Initialize bridge and persist flow (with nonce for recovery)
      // ====================================================================
      console.log('[Deposit] Creating bridge instance...');
      const bridge = await createBridge({
        azguardClient,
        evmProvider: walletClient,
      });

      // Create initial flow state with burner info (nonce is critical for recovery!)
      const initialFlow: BridgeFlowState = {
        status: 'opening',
        amount: amountBigInt,
        txHashes: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
        burner: {
          nonce,  // Timestamp nonce - allows recovery even if localStorage lost
          smartAccountAddress,
          eoaAddress,
        },
      };
      flowRef.current = initialFlow;
      startDepositFlow(initialFlow);
      console.log('[Deposit] Flow persisted to storage with nonce:', nonce);

      // ====================================================================
      // Step 3: Execute bridge (Aztec -> Base smart account)
      // ====================================================================
      setStage('opening');
      console.log('[Deposit] Executing deposit flow to smart account:', smartAccountAddress);

      const onProgress = (state: Partial<BridgeFlowState>) => {
        console.log('[Deposit] Progress:', state.status);

        if (state.status) {
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

        if (state.orderId) setOrderId(state.orderId);
        if (state.txHashes?.open) setOpenTxHash(state.txHashes.open);
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

      // Bridge to the SMART ACCOUNT address (not the user's wallet!)
      const result = await executeDeposit({
        bridge,
        amount: amountBigInt,
        recipientAddress: smartAccountAddress as Hex,
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

      // ====================================================================
      // Step 4: Create zkp2p deposit using sponsored smart account (GASLESS!)
      // ====================================================================
      setStage('depositing_zkp2p');
      updateDepositFlow({ status: 'claiming' });
      console.log('[Deposit] Creating zkp2p deposit via paymaster (gasless)...');

      // Create sponsored smart account client
      const smartAccountClient = await createSponsoredSmartAccountClient(burnerPrivateKey);

      // Calculate min/max intent amounts
      const minIntent = amountBigInt / 10n; // 10% minimum
      const maxIntent = amountBigInt; // 100% maximum

      const zkp2pResult = await createZkp2pDeposit({
        walletClient: smartAccountClient as any, // Smart account client is compatible
        amount: amountBigInt,
        minIntentAmount: minIntent,
        maxIntentAmount: maxIntent,
        paymentMethod,
        paymentTag,
        currency,
      });

      console.log('[Deposit] zkp2p deposit created:', zkp2pResult);
      setBaseTxHash(zkp2pResult.hash);

      // ====================================================================
      // Success!
      // ====================================================================
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
        setBurnerAddress(null);
        burnerKeyRef.current = null;
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
      setAztecTxPending(false);
    }
  };

  return (
    <div className="border border-gray-800 p-6 space-y-6">
      <div className="text-sm text-gray-500 uppercase tracking-wide">create deposit privately</div>

      {/* Active Flow Recovery Banner */}
      {hasActiveFlow && flowRef.current && (() => {
        const elapsed = Date.now() - (flowRef.current.updatedAt || flowRef.current.createdAt);
        const elapsedMin = Math.floor(elapsed / 60000);
        const isStale = elapsed > 10 * 60 * 1000; // > 10 min since last update
        const hasOpenedOrder = !!flowRef.current.orderId || !!flowRef.current.txHashes?.open;

        return (
          <div className={`border p-4 space-y-3 ${isStale ? 'border-red-700 bg-red-900/10' : 'border-yellow-600 bg-yellow-900/20'}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`text-lg ${isStale ? 'text-red-500' : 'text-yellow-500'}`}>!</span>
                <span className={`font-medium ${isStale ? 'text-red-400' : 'text-yellow-400'}`}>
                  {isStale ? 'Stale deposit detected' : 'Incomplete deposit found'}
                </span>
              </div>
              <span className={`text-xs ${isStale ? 'text-red-600' : 'text-gray-600'}`}>
                {elapsedMin < 1 ? '<1 min ago' : `${elapsedMin} min ago`}
              </span>
            </div>

            <div className="text-xs text-gray-400 space-y-1">
              <div>Order ID: <span className="text-white font-mono">{flowRef.current.orderId || 'pending'}</span></div>
              <div>Amount: <span className="text-white">{formatTokenAmount(flowRef.current.amount)} USDC</span></div>
              <div>Status: <span className={isStale ? 'text-red-400' : 'text-yellow-400'}>{stage}</span></div>
              {flowRef.current.burner && (
                <div>Burner: <button
                  onClick={() => navigator.clipboard.writeText(flowRef.current!.burner!.smartAccountAddress)}
                  title="Click to copy"
                  className="font-mono text-purple-400 hover:text-purple-300 cursor-pointer bg-transparent border-none p-0 text-xs"
                >{flowRef.current.burner.smartAccountAddress.slice(0, 10)}...{flowRef.current.burner.smartAccountAddress.slice(-6)}</button></div>
              )}
              {openTxHash && <div>Open TX: <span className="text-white font-mono text-xs">{openTxHash.slice(0, 10)}...</span></div>}
            </div>

            {isStale && (
              <div className="text-xs text-red-500 border border-red-900 p-2">
                This flow hasn&apos;t updated in {elapsedMin} min. It&apos;s likely stuck.
                {hasOpenedOrder && flowRef.current.burner
                  ? ' The bridge may have completed - try "recover & complete" to finish the zkp2p deposit.'
                  : ' You can safely clear this and try again.'}
              </div>
            )}

            {!isStale && (
              <div className="text-xs text-gray-500">
                {flowRef.current.burner
                  ? 'Funds may be on the burner address. Sign to recover and complete the deposit.'
                  : 'Your previous deposit is still in progress.'}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleDismissRecovery}
                disabled={isCreating}
                className="flex-1 py-2 text-xs border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition-colors disabled:opacity-50"
              >
                {hasOpenedOrder && flowRef.current.burner ? 'clear (funds on burner)' : 'clear'}
              </button>
              {flowRef.current.burner ? (
                <button
                  onClick={handleRecoverBurner}
                  disabled={isCreating}
                  className="flex-1 py-2 text-xs border border-green-700 text-green-400 hover:border-green-500 hover:text-green-300 transition-colors disabled:opacity-50"
                >
                  {isCreating ? 'recovering...' : 'recover & complete'}
                </button>
              ) : (
                <button
                  onClick={() => setHasActiveFlow(false)}
                  className="flex-1 py-2 text-xs border border-yellow-700 text-yellow-400 hover:border-yellow-500 hover:text-yellow-300 transition-colors"
                >
                  continue flow
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* Configuration Warnings */}
      {!bridgeConfigured && (
        <div className="text-xs text-yellow-600 border border-yellow-800 p-2">
          bridge not configured - check token addresses
        </div>
      )}
      {!paymasterConfigured && (
        <div className="text-xs text-yellow-600 border border-yellow-800 p-2">
          paymaster not configured - add NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL
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
            {(['deriving_burner', 'opening', 'waiting_filler', 'claiming', 'depositing_zkp2p', 'complete'] as const).map((s) => {
              const stages = ['deriving_burner', 'opening', 'waiting_filler', 'claiming', 'depositing_zkp2p', 'complete'];
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

          {/* Burner Address */}
          {burnerAddress && (
            <div className="text-xs text-gray-600 pt-2 border-t border-gray-800">
              burner: <button
                onClick={() => { navigator.clipboard.writeText(burnerAddress); }}
                title="Click to copy"
                className="font-mono text-purple-400 hover:text-purple-300 cursor-pointer bg-transparent border-none p-0"
              >{burnerAddress.slice(0, 10)}...{burnerAddress.slice(-6)}</button>
              <span className="text-gray-700 ml-2">(gasless via paymaster)</span>
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
          {burnerAddress && (
            <div className="text-xs text-gray-600">
              burner: <span className="font-mono">{burnerAddress}</span>
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

      {/* Submit / Cancel */}
      {isCreating ? (
        <button
          onClick={() => {
            console.log('[Deposit] User cancelled active flow');
            failDepositFlow('cancelled by user');
            setIsCreating(false);
            setAztecTxPending(false);
            setStage('error');
            setError('cancelled by user');
            if (waitingTimerRef.current) {
              clearInterval(waitingTimerRef.current);
              waitingTimerRef.current = null;
            }
          }}
          className="w-full py-3 border border-red-800 text-red-400 hover:border-red-600 hover:text-red-300 transition-colors"
        >
          cancel
        </button>
      ) : (
        <button
          onClick={handleCreate}
          disabled={!amount || !hasEnoughBalance || !evmAddress || hasActiveFlow}
          className="w-full py-3 border border-gray-600 hover:border-white hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          create deposit
        </button>
      )}

      {/* Wallet Connection Warning */}
      {!evmAddress && (
        <p className="text-xs text-yellow-600">connect base wallet to create deposits</p>
      )}

      {/* Info */}
      <div className="text-xs text-gray-700 space-y-1">
        <p>deposits are created from a fresh burner address for privacy</p>
        <p>gas is sponsored - no ETH needed on the burner</p>
      </div>

      {/* Completed Flow History */}
      {completedFlows.filter(f => f.direction === 'aztec_to_base').length > 0 && (
        <div className="border-t border-gray-800 pt-4 space-y-3">
          <div className="text-xs text-gray-600 uppercase tracking-wide">deposit history</div>
          <div className="space-y-2">
            {completedFlows
              .filter(f => f.direction === 'aztec_to_base')
              .slice()
              .reverse()
              .map((flow, i) => {
                const date = new Date(flow.updatedAt || flow.createdAt);
                const timeStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                const isSuccess = flow.status === 'completed';

                return (
                  <div key={`${flow.orderId || i}-${flow.createdAt}`} className="flex items-center justify-between text-xs border border-gray-800 p-2">
                    <div className="flex items-center gap-2">
                      <span className={isSuccess ? 'text-green-600' : 'text-red-600'}>
                        {isSuccess ? '✓' : '✗'}
                      </span>
                      <span className="text-white">{formatTokenAmount(BigInt(flow.amount))} USDC</span>
                      {flow.burner && (
                        <button
                          onClick={() => navigator.clipboard.writeText(flow.burner!.smartAccountAddress)}
                          title="Click to copy burner address"
                          className="font-mono text-purple-400 hover:text-purple-300 cursor-pointer bg-transparent border-none p-0 text-xs"
                        >
                          {flow.burner.smartAccountAddress.slice(0, 6)}...{flow.burner.smartAccountAddress.slice(-4)}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-gray-600">
                      <span>{timeStr}</span>
                      {flow.txHashes?.claim && (
                        <a
                          href={`https://sepolia.basescan.org/tx/${flow.txHashes.claim}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 underline"
                        >
                          tx
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
