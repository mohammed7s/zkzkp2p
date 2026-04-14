

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { type Hex } from 'viem';
import { useWalletStore } from '@/stores/walletStore';
import { useFlowStore } from '@/stores/flowStore';
import {
  executeBridge,
  isBridgeConfigured,
  formatTokenAmount,
  parseTokenAmount,
} from '@/lib/nearIntents';
import type { BridgeFlowState, BridgeStatus } from '@/lib/bridge/types';
import { createZkp2pDeposit } from '@/lib/zkp2p/client';
import { ZKP2P, BASE_EXPLORER_URL } from '@/config';

// Burner derivation (two-layer: master key + sequential index)
import {
  deriveBurner,
  recoverBurner,
  scanAndRecover,
  type FundedBurner,
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
  onClose?: () => void;
}

const PAYMENT_METHODS = ZKP2P.paymentMethods;
const CURRENCIES = ZKP2P.currencies;

// Deposit flow stages (with NEAR Intents mock bridge)
type DepositStage =
  | 'idle'
  | 'deriving_burner'     // Signing to derive burner key
  | 'sending_to_solver'   // Sending Aztec USDC to solver (real Aztec tx)
  | 'waiting_for_funds'   // Waiting for solver to send Base USDC to burner
  | 'depositing_zkp2p'    // Creating zkp2p deposit (gasless via paymaster)
  | 'complete'
  | 'error';

const STAGE_LABELS: Record<DepositStage, string> = {
  idle: '',
  deriving_burner: 'deriving keys',
  sending_to_solver: 'generating proof',
  waiting_for_funds: 'bridging',
  depositing_zkp2p: 'depositing',
  complete: 'complete',
  error: 'failed',
};

const STAGE_DETAILS: Record<DepositStage, string> = {
  idle: '',
  deriving_burner: 'signing in metamask to derive one-time burner key...',
  sending_to_solver: 'generating zero-knowledge proof in your browser. this takes 1-2 minutes — your transaction stays completely private.',
  waiting_for_funds: 'proof verified. bridging USDC from aztec to base...',
  depositing_zkp2p: 'creating deposit on peer.xyz (gasless)...',
  complete: 'your deposit is live on peer.xyz!',
  error: 'see error below',
};

export function CreateDeposit({ privateBalance, onRefreshBalances, onClose }: CreateDepositProps) {
  const bridgeOnlyMode = import.meta.env.NEXT_PUBLIC_BRIDGE_ONLY_MODE !== 'false';
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<typeof PAYMENT_METHODS[number]>('revolut');
  const [currency, setCurrency] = useState<typeof CURRENCIES[number]>('USD');
  const [paymentTag, setPaymentTag] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<DepositStage>('idle');
  const [aztecTxHash, setAztecTxHash] = useState<string | null>(null);
  const [baseTxHash, setBaseTxHash] = useState<string | null>(null);
  const [waitingTime, setWaitingTime] = useState(0);
  const [hasActiveFlow, setHasActiveFlow] = useState(false);
  const [burnerAddress, setBurnerAddress] = useState<string | null>(null);

  // Funded burners found by scan (pending recovery)
  const [fundedBurners, setFundedBurners] = useState<FundedBurner[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  const flowRef = useRef<BridgeFlowState | null>(null);
  const waitingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const burnerKeyRef = useRef<Hex | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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
      console.log('[Deposit] Found active flow to recover:', savedFlow.status);
      setHasActiveFlow(true);
      flowRef.current = savedFlow;
      if (savedFlow.txHashes?.open) setAztecTxHash(savedFlow.txHashes.open);
      if (savedFlow.txHashes?.claim) setBaseTxHash(savedFlow.txHashes.claim);
      if (savedFlow.burner?.smartAccountAddress) setBurnerAddress(savedFlow.burner.smartAccountAddress);

      // Map flow status to UI stage
      const statusToStage: Partial<Record<BridgeStatus, DepositStage>> = {
        'opening': 'waiting_for_funds',
        'waiting_filler': 'waiting_for_funds',
        'claiming': 'depositing_zkp2p',
        'completed': 'complete',
        'error': 'error',
      };
      const recoveredStage = statusToStage[savedFlow.status] || 'idle';
      if (recoveredStage !== 'idle') {
        setStage(recoveredStage);
      }
    }
  }, [getActiveDepositFlow]);

  // Cleanup timer and abort controller on unmount
  useEffect(() => {
    return () => {
      if (waitingTimerRef.current) clearInterval(waitingTimerRef.current);
      abortControllerRef.current?.abort();
    };
  }, []);

  // Wagmi hooks (must be before any effects that use them)
  const { address: evmAddress } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  // Scan for funded burners on connect (auto-recovery)
  useEffect(() => {
    if (!evmAddress || !walletClient || !publicClient || stage !== 'idle' || hasActiveFlow) return;
    const tokenAddr = import.meta.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS;
    if (!tokenAddr) return;

    let cancelled = false;
    (async () => {
      setIsScanning(true);
      try {
        const result = await scanAndRecover(
          walletClient,
          evmAddress as Hex,
          publicClient,
          tokenAddr as Hex,
          getSmartAccountAddress,
        );
        if (!cancelled && result.fundedBurners.length > 0) {
          console.log('[Deposit] Found funded burners:', result.fundedBurners.map(b => ({
            index: b.index,
            address: b.smartAccountAddress,
            balance: b.balance.toString(),
          })));
          setFundedBurners(result.fundedBurners);
        }
      } catch (e: any) {
        console.warn('[Deposit] Burner scan failed:', e.message);
      } finally {
        if (!cancelled) setIsScanning(false);
      }
    })();
    return () => { cancelled = true; };
  }, [evmAddress, walletClient, publicClient, stage, hasActiveFlow]);

  // Clear stale state when stage becomes idle
  useEffect(() => {
    if (stage === 'idle') {
      setAztecTxHash(null);
      setBaseTxHash(null);
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

  // These are already declared above via useWalletClient/usePublicClient/useAccount for scan
  // Keep them here as the canonical declarations for the rest of the component
  const { aztecAddress: aztecAddr, aztecWallet, setAztecTxPending } = useWalletStore();

  const amountBigInt = amount ? parseTokenAmount(amount) : 0n;
  const hasEnoughBalance = privateBalance >= amountBigInt;

  // Check if bridge and paymaster are configured
  const bridgeConfigured = isBridgeConfigured();
  const paymasterConfigured = bridgeOnlyMode ? true : isPaymasterConfigured();

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

      const burnerIndex = savedFlow.burner.nonce ?? 0;
      console.log('[Deposit] Recovering burner key with index:', burnerIndex);
      const { privateKey: burnerPrivateKey, eoaAddress } = await recoverBurner(
        walletClient,
        evmAddress,
        burnerIndex
      );

      if (eoaAddress.toLowerCase() !== savedFlow.burner.eoaAddress.toLowerCase()) {
        throw new Error('Recovered address mismatch - are you using the same wallet?');
      }

      burnerKeyRef.current = burnerPrivateKey;
      console.log('[Deposit] Burner recovered:', eoaAddress);

      setStage('depositing_zkp2p');

      const smartAccountClient = await createSponsoredSmartAccountClient(burnerPrivateKey);
      const minIntent = savedFlow.amount / 10n;
      const maxIntent = savedFlow.amount;

      const zkp2pResult = await createZkp2pDeposit({
        walletClient: smartAccountClient as any,
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
    } catch (err) {
      console.error('[Deposit] Recovery error:', err);
      setError(err instanceof Error ? err.message : 'Recovery failed');
    } finally {
      setIsCreating(false);
    }
  }, [getActiveDepositFlow, walletClient, evmAddress, paymentMethod, paymentTag, currency, completeDepositFlow, onRefreshBalances]);

  const handleCreate = async () => {
    if (!aztecWallet || !aztecAddr || !evmAddress || !walletClient || !publicClient) {
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

    if (!bridgeOnlyMode && !paymentTag.trim()) {
      setError('enter your payment tag');
      return;
    }

    if (!bridgeOnlyMode && !paymasterConfigured) {
      setError('paymaster not configured - add NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL to .env');
      return;
    }

    setIsCreating(true);
    setError(null);
    setAztecTxHash(null);
    setBaseTxHash(null);
    setWaitingTime(0);
    setBurnerAddress(null);

    setAztecTxPending(true);

    if (waitingTimerRef.current) {
      clearInterval(waitingTimerRef.current);
      waitingTimerRef.current = null;
    }

    abortControllerRef.current = new AbortController();

    try {
      // ====================================================================
      // Check if a funded burner can cover this deposit (skip bridge step)
      // ====================================================================
      let burnerPrivateKey: Hex | undefined;
      let smartAccountAddress: string | undefined;
      let receivedBalance: bigint | undefined;
      let skipBridge = false;

      const matchingBurner = fundedBurners.find(b => b.balance >= amountBigInt);
      if (matchingBurner) {
        console.log('[Deposit] Reusing funded burner #' + matchingBurner.index, matchingBurner.smartAccountAddress);
        setStage('deriving_burner');

        const recovered = await recoverBurner(walletClient, evmAddress, matchingBurner.index);
        burnerPrivateKey = recovered.privateKey;
        smartAccountAddress = matchingBurner.smartAccountAddress;
        receivedBalance = matchingBurner.balance;
        setBurnerAddress(smartAccountAddress);
        burnerKeyRef.current = burnerPrivateKey;
        skipBridge = true;

        // Remove this burner from the list
        setFundedBurners(prev => prev.filter(b => b.index !== matchingBurner.index));
      }

      if (!skipBridge) {
        // ====================================================================
        // Step 1: Derive burner key (master key + sequential index)
        // ====================================================================
        setStage('deriving_burner');
        console.log('[Deposit] Deriving burner key...');

        const { privateKey, eoaAddress, index: burnerIndex } = await deriveBurner(
          walletClient,
          evmAddress
        );
        burnerPrivateKey = privateKey;
        burnerKeyRef.current = burnerPrivateKey;

        smartAccountAddress = await getSmartAccountAddress(burnerPrivateKey);
        setBurnerAddress(smartAccountAddress);

        console.log('[Deposit] Burner derived:', { index: burnerIndex, eoaAddress, smartAccountAddress });

        // ====================================================================
        // Step 2: Bridge Aztec USDC → Base USDC via executeBridge()
        // ====================================================================
        const initialFlow: BridgeFlowState = {
          status: 'opening',
          amount: amountBigInt,
          txHashes: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
          burner: {
            nonce: burnerIndex,
            smartAccountAddress,
            eoaAddress,
          },
        };
        flowRef.current = initialFlow;
        startDepositFlow(initialFlow);

        setStage('sending_to_solver');

        const bridgeResult = await executeBridge({
          aztecWallet,
          aztecSender: aztecAddr,
          amount: amountBigInt,
          baseRecipient: smartAccountAddress as Hex,
          publicClient,
          abortSignal: abortControllerRef.current.signal,
        callbacks: {
          onSendingToSolver: () => {
            console.log('[Deposit] Sending Aztec USDC to solver...');
          },
          onSolverTxConfirmed: (txHash) => {
            console.log('[Deposit] Aztec tx confirmed:', txHash);
            setAztecTxHash(txHash);
            updateDepositFlow({ status: 'waiting_filler', txHashes: { open: txHash } });
            setStage('waiting_for_funds');
            // Start waiting timer after Aztec tx confirms
            waitingTimerRef.current = setInterval(() => {
              setWaitingTime(prev => prev + 1);
            }, 1000);
          },
          onWaitingForFunds: (addr) => {
            console.log('[Deposit] Waiting for solver to fill:', addr);
          },
          onFundsSentTx: (txHash) => {
            console.log('[Deposit] Solver Base tx sent:', txHash);
            setBaseTxHash(txHash);
            updateDepositFlow({ txHashes: { claim: txHash } });
          },
          onFundsReceived: (bal) => {
            console.log('[Deposit] Funds received:', bal.toString());
            updateDepositFlow({ status: 'claiming' });
          },
        },
        });

        if (waitingTimerRef.current) {
          clearInterval(waitingTimerRef.current);
          waitingTimerRef.current = null;
        }

        receivedBalance = bridgeResult.receivedAmount;
        setAztecTxHash(bridgeResult.aztecTxHash);

        console.log('[Deposit] Bridge complete, received:', receivedBalance.toString());
        onRefreshBalances(true);

        if (bridgeOnlyMode) {
          console.log('[Deposit] Bridge-only mode complete. Burner funded; skipping peer.xyz deposit.');
          setStage('complete');
          completeDepositFlow();

          setTimeout(() => {
            setStage('idle');
            setAmount('');
            setPaymentTag('');
            setAztecTxHash(null);
            setBaseTxHash(null);
            setWaitingTime(0);
            setBurnerAddress(null);
            burnerKeyRef.current = null;
            flowRef.current = null;
            onRefreshBalances();
          }, 3000);
          return;
        }
      } // end if (!skipBridge)

      // ====================================================================
      // Step 3: Create zkp2p deposit using sponsored smart account (GASLESS)
      // ====================================================================
      setStage('depositing_zkp2p');
      updateDepositFlow({ status: 'claiming' });
      console.log('[Deposit] Creating zkp2p deposit via paymaster (gasless)...');

      const smartAccountClient = await createSponsoredSmartAccountClient(burnerPrivateKey!);

      const actualReceived = receivedBalance ?? amountBigInt;
      const depositAmount = actualReceived < amountBigInt ? actualReceived : amountBigInt;
      const minIntent = depositAmount / 10n;
      const maxIntent = depositAmount;

      const zkp2pResult = await createZkp2pDeposit({
        walletClient: smartAccountClient as any,
        amount: depositAmount,
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

      // Don't auto-reset — let the user see the success state and dismiss manually
      onRefreshBalances();

    } catch (err) {
      console.error('[Deposit] Error:', err);
      const errorMessage = err instanceof Error ? err.message : 'failed to create deposit';
      setError(errorMessage);
      setStage('error');
      failDepositFlow(errorMessage);

      if (waitingTimerRef.current) {
        clearInterval(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }
    } finally {
      setIsCreating(false);
      setAztecTxPending(false);
      abortControllerRef.current = null;
    }
  };

  return (
    <div className="border border-gray-800 p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-500 uppercase tracking-wide">deposit on peer.xyz</div>
        {onClose && stage === 'idle' && (
          <button
            onClick={onClose}
            className="text-xs text-gray-600 hover:text-gray-400"
          >cancel</button>
        )}
      </div>

      {/* Active Flow Recovery Banner */}
      {hasActiveFlow && flowRef.current && (() => {
        const elapsed = Date.now() - (flowRef.current.updatedAt || flowRef.current.createdAt);
        const elapsedMin = Math.floor(elapsed / 60000);
        const isStale = elapsed > 10 * 60 * 1000;

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
              <div>Amount: <span className="text-white">{formatTokenAmount(flowRef.current.amount)} USDC</span></div>
              <div>Status: <span className={isStale ? 'text-red-400' : 'text-yellow-400'}>{stage}</span></div>
              {flowRef.current.burner && (
                <div>Burner: <a
                  href={`${BASE_EXPLORER_URL}/address/${flowRef.current.burner.smartAccountAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in explorer"
                  className="font-mono text-purple-400 hover:text-purple-300 text-xs underline"
                >{flowRef.current.burner.smartAccountAddress.slice(0, 10)}...{flowRef.current.burner.smartAccountAddress.slice(-6)}</a></div>
              )}
            </div>

            {isStale && flowRef.current.burner && (
              <div className="text-xs text-red-500 border border-red-900 p-2">
                This flow hasn&apos;t updated in {elapsedMin} min.
                Try &quot;recover &amp; complete&quot; to finish the zkp2p deposit.
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleDismissRecovery}
                disabled={isCreating}
                className="flex-1 py-2 text-xs border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition-colors disabled:opacity-50"
              >
                clear
              </button>
              {flowRef.current.burner && (
                <button
                  onClick={handleRecoverBurner}
                  disabled={isCreating}
                  className="flex-1 py-2 text-xs border border-green-700 text-green-400 hover:border-green-500 hover:text-green-300 transition-colors disabled:opacity-50"
                >
                  {isCreating ? 'recovering...' : 'recover & complete'}
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* Scanning indicator */}
      {isScanning && (
        <div className="text-xs text-gray-500 animate-pulse">scanning wallets...</div>
      )}

      {/* Configuration Warnings */}
      {!bridgeConfigured && (
        <div className="text-xs text-yellow-600 border border-yellow-800 p-2">
          bridge not configured
        </div>
      )}
      {!paymasterConfigured && (
        <div className="text-xs text-yellow-600 border border-yellow-800 p-2">
          paymaster not configured - add NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL
        </div>
      )}
      {bridgeOnlyMode && (
        <div className="text-xs text-blue-500 border border-blue-900 p-2">
          bridge-only test mode enabled - flow stops after burner funding
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

      {!bridgeOnlyMode && (
        <>
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
        </>
      )}

      {/* Status Stages */}
      {stage !== 'idle' && stage !== 'error' && (
        <div className="border border-gray-800 p-4 space-y-3">
          <div className="text-xs text-gray-500 uppercase">deposit progress</div>

          <div className="space-y-2">
            {(['deriving_burner', 'sending_to_solver', 'waiting_for_funds', 'depositing_zkp2p', 'complete'] as const).map((s) => {
              const stages: DepositStage[] = ['deriving_burner', 'sending_to_solver', 'waiting_for_funds', 'depositing_zkp2p', 'complete'];
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
                    {isActive && s === 'waiting_for_funds' && waitingTime > 0 && (
                      <span className="text-gray-500 ml-2">({waitingTime}s)</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Current Stage Details */}
          {STAGE_DETAILS[stage] && stage !== 'complete' && (
            <div className={`pt-2 border-t border-gray-800 ${stage === 'sending_to_solver' ? 'space-y-2' : ''}`}>
              {stage === 'sending_to_solver' ? (
                <div className="border border-gray-700 bg-gray-900/50 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-gray-500 border-t-white rounded-full animate-spin" />
                    <span className="text-sm text-gray-300">generating zero-knowledge proof</span>
                  </div>
                  <p className="text-xs text-gray-500">
                    this takes 1-2 minutes. your transaction is being encrypted so it stays completely private on aztec.
                  </p>
                  <div className="w-full bg-gray-800 h-1 overflow-hidden">
                    <div className="h-full bg-gray-600 animate-pulse" style={{ width: '60%' }} />
                  </div>
                </div>
              ) : (
                <div className="text-xs text-yellow-600 animate-pulse">
                  {STAGE_DETAILS[stage]}
                </div>
              )}
            </div>
          )}
          {stage === 'complete' && (
            <div className="text-xs text-green-400 pt-2 border-t border-gray-800">
              {STAGE_DETAILS[stage]}
            </div>
          )}

          {/* Burner Address — prominent when waiting for funds */}
          {burnerAddress && stage === 'waiting_for_funds' && (
            <div className="border border-purple-800 bg-purple-900/10 p-3 space-y-2">
              <div className="text-xs text-purple-400 uppercase">send USDC to this address</div>
              <a
                href={`${BASE_EXPLORER_URL}/address/${burnerAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { e.preventDefault(); navigator.clipboard.writeText(burnerAddress).then(() => window.open(`${BASE_EXPLORER_URL}/address/${burnerAddress}`, '_blank')).catch(() => window.open(`${BASE_EXPLORER_URL}/address/${burnerAddress}`, '_blank')); }}
                title="Click to copy + open explorer"
                className="font-mono text-sm text-white hover:text-purple-300 cursor-pointer break-all text-left underline decoration-purple-800 hover:decoration-purple-400"
              >{burnerAddress}</a>
              <div className="text-xs text-gray-600">
                amount: {formatTokenAmount(amountBigInt)} USDC on Base
              </div>
              <div className="text-xs text-gray-700">
                polling every 5s for balance...
              </div>
            </div>
          )}

          {/* Burner Address — compact for other stages */}
          {burnerAddress && stage !== 'waiting_for_funds' && (
            <div className="text-xs text-gray-600 pt-2 border-t border-gray-800">
              burner: <a
                href={`${BASE_EXPLORER_URL}/address/${burnerAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in explorer"
                className="font-mono text-purple-400 hover:text-purple-300 underline"
              >{burnerAddress.slice(0, 10)}...{burnerAddress.slice(-6)}</a>
              <span className="text-gray-700 ml-2">(gasless via paymaster)</span>
            </div>
          )}

          {/* Transaction Hashes */}
          {(aztecTxHash || baseTxHash) && (
            <div className="text-xs text-gray-600 pt-2 border-t border-gray-800 space-y-1">
              {aztecTxHash && (
                <div>aztec tx: <a href={`https://testnet.aztecscan.xyz/tx-effects/${aztecTxHash}`} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 font-mono underline">{aztecTxHash.slice(0, 10)}...{aztecTxHash.slice(-8)}</a></div>
              )}
              {baseTxHash && (
                <div>base tx: <a href={`https://basescan.org/tx/${baseTxHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{baseTxHash.slice(0, 10)}...{baseTxHash.slice(-8)}</a></div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Success */}
      {stage === 'complete' && (
        <div className="border border-green-900 bg-green-950/20 p-4 space-y-3">
          <div className="text-sm text-green-400">deposit live on peer.xyz</div>
          <div className="text-xs text-gray-400 space-y-1">
            {aztecTxHash && (
              <div>aztec: <a href={`https://testnet.aztecscan.xyz/tx-effects/${aztecTxHash}`} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline font-mono">{aztecTxHash.slice(0, 12)}...</a></div>
            )}
            {baseTxHash && (
              <div>deposit: <a href={`https://basescan.org/tx/${baseTxHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline font-mono">{baseTxHash.slice(0, 12)}...</a></div>
            )}
          </div>
          <button
            onClick={() => {
              setStage('idle');
              setAmount('');
              setPaymentTag('');
              setAztecTxHash(null);
              setBaseTxHash(null);
              setWaitingTime(0);
              setBurnerAddress(null);
              burnerKeyRef.current = null;
              flowRef.current = null;
            }}
            className="text-xs text-gray-500 hover:text-white border border-gray-700 hover:border-gray-500 px-3 py-1"
          >
            done
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="border border-red-900 p-3 space-y-2">
          <div className="text-sm text-red-500">{error}</div>
          {burnerAddress && (
            <div className="text-xs text-gray-600">
              burner: <span className="font-mono">{burnerAddress}</span>
            </div>
          )}
          {aztecTxHash && (
            <div className="text-xs text-gray-600">
              aztec tx: <a href={`https://testnet.aztecscan.xyz/tx-effects/${aztecTxHash}`} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 font-mono underline">{aztecTxHash.slice(0, 16)}...</a>
            </div>
          )}
          {baseTxHash && (
            <div className="text-xs text-gray-600">
              base tx: <a href={`https://basescan.org/tx/${baseTxHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline font-mono">{baseTxHash.slice(0, 16)}...</a>
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
            abortControllerRef.current?.abort();
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
          {bridgeOnlyMode ? 'fund burner' : 'create deposit'}
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
        <p className="text-yellow-800">
          {bridgeOnlyMode
            ? 'pre-alpha: bridge-only test mode - burner funding only'
            : 'pre-alpha: bridge uses a hardcoded mock solver'}
        </p>
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
                  <div key={`${i}-${flow.createdAt}`} className="flex items-center justify-between text-xs border border-gray-800 p-2">
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
                          href={`https://basescan.org/tx/${flow.txHashes.claim}`}
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
