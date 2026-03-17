

import { useState, useEffect, useRef } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useWalletStore } from '@/stores/walletStore';
import { useFlowStore } from '@/stores/flowStore';
import { BASE_CHAIN } from '@/config';
import {
  formatTokenAmount,
  parseTokenAmount,
  TOKENS,
} from '@/lib/bridge';
import {
  executeBaseToAztecBridge,
  fundBaseAddressFromSolver,
  isBaseFaucetAvailable,
  isBaseToAztecBridgeConfigured,
} from '@/lib/nearIntents';
// Transfer to private is done via the aztecWallet directly
import type { BridgeFlowState } from '@/lib/bridge/types';

interface PrivateAccountProps {
  privateBalance: bigint;
  publicBalance: bigint;
  baseBalance: bigint;
  isEvmConnected: boolean;
  onTopUp: () => void;
}

// Shield flow stages (mock solver flow)
type ShieldStage =
  | 'idle'
  | 'opening'         // Sending Base USDC to solver
  | 'waiting_filler'  // Waiting for solver to fill on Aztec
  | 'claiming'        // Solver tx confirmed, waiting for balance refresh
  | 'complete'
  | 'error';

export function PrivateAccount({
  privateBalance,
  publicBalance,
  baseBalance,
  isEvmConnected,
  onTopUp,
}: PrivateAccountProps) {
  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [isTopingUp, setIsTopingUp] = useState(false);
  const [isFauceting, setIsFauceting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<ShieldStage>('idle');
  const [baseTxHash, setBaseTxHash] = useState<string | null>(null);
  const [aztecTxHash, setAztecTxHash] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [flowState, setFlowState] = useState<BridgeFlowState | null>(null);
  const [waitingTime, setWaitingTime] = useState(0);
  const waitingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isTransferringToPrivate, setIsTransferringToPrivate] = useState(false);
  const [lastCompleted, setLastCompleted] = useState<{
    baseTxHash: string | null;
    aztecTxHash: string | null;
    orderId: string | null;
    amount: string;
  } | null>(null);

  // Flow store for persistence
  const {
    startShieldFlow,
    updateShieldFlow,
    completeShieldFlow,
    failShieldFlow,
    getActiveShieldFlow,
    clearActiveFlows,
  } = useFlowStore();

  // Load persisted flow state on mount
  useEffect(() => {
    const savedFlow = getActiveShieldFlow();
      if (savedFlow && savedFlow.status !== 'completed' && savedFlow.status !== 'error') {
      console.log('[TopUp] Found active flow to recover:', savedFlow.orderId, savedFlow.status);
      setFlowState(savedFlow);
      setOrderId(savedFlow.orderId || null);
      if (savedFlow.txHashes?.open) setBaseTxHash(savedFlow.txHashes.open);
      if (savedFlow.txHashes?.claim) setAztecTxHash(savedFlow.txHashes.claim);

      // Map flow status to UI stage
      const statusToStage: Record<string, ShieldStage> = {
        idle: 'idle',
        opening: 'opening',
        waiting_filler: 'waiting_filler',
        claiming: 'claiming',
        completed: 'complete',
        error: 'error',
      };
      const recoveredStage = statusToStage[savedFlow.status] || 'idle';
      if (recoveredStage !== 'idle') {
        setStage(recoveredStage);
        setShowTopUp(true); // Show the panel for in-progress flow
      }
    }
  }, [getActiveShieldFlow]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (waitingTimerRef.current) {
        clearInterval(waitingTimerRef.current);
      }
    };
  }, []);

  const { address: evmAddress, chainId } = useAccount();
  const { aztecAddress, aztecWallet, setAztecTxPending } = useWalletStore();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const chainMismatch = !!chainId && chainId !== BASE_CHAIN.id;

  // Helper to detect user rejection
  const isUserRejection = (error: any): boolean => {
    const message = error?.message?.toLowerCase() || '';
    const code = error?.code;
    return (
      message.includes('user rejected') ||
      message.includes('user denied') ||
      message.includes('user cancelled') ||
      code === 4001 ||
      code === 'ACTION_REJECTED'
    );
  };

  // Cancel/reset the entire flow
  const handleCancelFlow = () => {
    if (waitingTimerRef.current) {
      clearInterval(waitingTimerRef.current);
      waitingTimerRef.current = null;
    }
    setStage('idle');
    setFlowState(null);
    setBaseTxHash(null);
    setAztecTxHash(null);
    setOrderId(null);
    setError(null);
    setWaitingTime(0);
    clearActiveFlows();
    console.log('[TopUp] Flow cancelled and reset');
  };

  const handleFaucet = async () => {
    if (!publicClient || !evmAddress || !isBaseFaucetAvailable()) return;

    setIsFauceting(true);
    setError(null);
    setStatus('sending test USDC...');

    try {
      const txHash = await fundBaseAddressFromSolver({
        recipientAddress: evmAddress,
        amount: 20n * 10n ** 6n, // 20 USDC
        publicClient,
      });
      console.log('[PrivateAccount] Faucet tx:', txHash);
      setStatus('test USDC received');
      onTopUp();
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      if (isUserRejection(err)) {
        setStatus(null);
      } else {
        setError(err instanceof Error ? err.message : 'faucet failed');
        setStatus(null);
      }
    } finally {
      setIsFauceting(false);
    }
  };

  const handleTopUp = async () => {
    if (!isEvmConnected || !evmAddress) {
      setError('connect your base wallet');
      return;
    }

    if (chainMismatch) {
      setError(`switch your wallet to ${BASE_CHAIN.name}`);
      return;
    }

    if (!walletClient) {
      setError('wallet signer not ready - reconnect or switch network');
      return;
    }

    if (!publicClient) {
      setError('base client not ready');
      return;
    }

    if (!aztecAddress || !aztecWallet) {
      setError('aztec wallet still setting up - wait a moment and try again');
      return;
    }

    const amount = parseTokenAmount(topUpAmount);
    if (amount <= 0n) {
      setError('enter an amount');
      return;
    }

    if (baseBalance < amount) {
      setError('insufficient base balance');
      return;
    }

    if (!isBaseToAztecBridgeConfigured()) {
      setError('bridge not configured - check solver and token config');
      return;
    }

    setIsTopingUp(true);
    setError(null);
    setBaseTxHash(null);
    setAztecTxHash(null);
    setOrderId(null);
    setStage('idle');
    setFlowState(null);
    setWaitingTime(0);

    // Clear any existing timer
    if (waitingTimerRef.current) {
      clearInterval(waitingTimerRef.current);
      waitingTimerRef.current = null;
    }

    setAztecTxPending(true);
    try {
      // Create initial flow state for persistence
      const initialFlow: BridgeFlowState = {
        status: 'opening',
        amount,
        txHashes: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setFlowState(initialFlow);
      startShieldFlow(initialFlow);
      console.log('[TopUp] Flow persisted to storage');

      // Execute mock shield flow (Base -> solver on Base -> private Aztec fill)
      setStage('opening');
      console.log('[TopUp] Executing mock shield flow...');

      const result = await executeBaseToAztecBridge({
        walletClient,
        publicClient,
        evmSender: evmAddress,
        aztecRecipient: aztecAddress,
        amount,
        callbacks: {
          onSendingToSolver: () => {
            console.log('[TopUp] Sending Base USDC to solver...');
            setStage('opening');
            updateShieldFlow({ status: 'opening' });
          },
          onBaseTxConfirmed: (txHash) => {
            console.log('[TopUp] Base tx confirmed:', txHash);
            setBaseTxHash(txHash);
            setStage('waiting_filler');
            updateShieldFlow({
              status: 'waiting_filler',
              txHashes: { open: txHash },
            });
            waitingTimerRef.current = setInterval(() => {
              setWaitingTime(prev => prev + 1);
            }, 1000);
          },
          onWaitingForFill: (recipient) => {
            console.log('[TopUp] Waiting for solver fill for:', recipient);
            setStatus('preparing private fill on aztec - proof generation can take 1-3 minutes');
          },
          onAztecTxConfirmed: (txHash) => {
            console.log('[TopUp] Aztec fill confirmed:', txHash);
            setAztecTxHash(txHash);
            setStage('claiming');
            setStatus('private fill confirmed on aztec');
            updateShieldFlow({
              status: 'claiming',
              txHashes: { claim: txHash },
            });
          },
        },
      });

      console.log('[TopUp] Mock shield complete:', result);

      // Stop timer
      if (waitingTimerRef.current) {
        clearInterval(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }

      // Mark as complete
      setStage('complete');
      completeShieldFlow();

      // Save completed flow info for success banner, then reset flow state
      setLastCompleted({
        baseTxHash: result.baseTxHash,
        aztecTxHash: result.aztecTxHash,
        orderId: null,
        amount: topUpAmount,
      });
      setStatus('shield complete');
      onTopUp();
      setStage('idle');
      setIsTopingUp(false);
      setTopUpAmount('');
      setBaseTxHash(null);
      setAztecTxHash(null);
      setOrderId(null);
      setFlowState(null);
      setWaitingTime(0);

    } catch (err) {
      if (isUserRejection(err)) {
        setStage('idle');
        setStatus(null);
        setError(null);
        setFlowState(null);
      } else {
        console.error('[TopUp] Error:', err);
        setError(err instanceof Error ? err.message : 'top up failed');
        setStage('error');
        failShieldFlow(err instanceof Error ? err.message : 'top up failed');
      }

      // Clear timer on error
      if (waitingTimerRef.current) {
        clearInterval(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }
    } finally {
      setIsTopingUp(false);
      setAztecTxPending(false);
    }
  };

  // Transfer public balance to private (shield)
  const handleTransferToPrivate = async () => {
    if (!aztecWallet || !aztecAddress || publicBalance <= 0n) return;

    setIsTransferringToPrivate(true);
    setError(null);
    setStatus('setting up sponsored fee...');

    try {
      console.log('[PrivateAccount] Transferring', publicBalance.toString(), 'from public to private');

      const { AztecAddress } = await import('@aztec/aztec.js/addresses');
      const { Fr } = await import('@aztec/aztec.js/fields');
      const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
      const { SponsoredFPCContract } = await import('@aztec/noir-contracts.js/SponsoredFPC');
      const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee/testing');
      const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');

      // Get SponsoredFPC address for fee payment (already registered during wallet creation)
      const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
        SponsoredFPCContract.artifact,
        { salt: new Fr(0) },
      );
      const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);

      const tokenAddr = AztecAddress.fromString(TOKENS.aztec.address);
      const userAddr = AztecAddress.fromString(aztecAddress);

      setStatus('sending transfer_to_private...');

      const token = await TokenContract.at(tokenAddr, aztecWallet);
      const receipt = await token.methods
        .transfer_to_private(userAddr, publicBalance)
        .send({ from: userAddr, fee: { paymentMethod }, wait: { timeout: 300 } });

      console.log('[PrivateAccount] Transfer to private receipt:', receipt);
      setStatus('transferred to private!');
      setAztecTxPending(true);
      setTimeout(() => {
        setStatus(null);
        setAztecTxPending(false);
        onTopUp(); // Refresh balances
      }, 3000);
    } catch (err) {
      console.error('[PrivateAccount] Transfer to private failed:', err);
      if (isUserRejection(err)) {
        setStatus(null);
      } else {
        setError(err instanceof Error ? err.message : 'transfer failed');
        setStatus(null);
      }
    } finally {
      setIsTransferringToPrivate(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Aztec Wallet - Purple accent */}
      <div className="border border-purple-900/50 bg-purple-950/10 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-purple-500"></div>
          <div className="text-sm text-purple-400 uppercase tracking-wide">aztec wallet</div>
        </div>

        {/* Private Balance */}
        <div className="text-center py-6 border border-purple-900/30 bg-purple-950/20">
          <div className="text-3xl text-white">{formatTokenAmount(privateBalance)}</div>
          <div className="text-sm text-purple-400 mt-1">private USDC</div>
        </div>

        {/* Public Balance (leftover from bridge) */}
        <div className="flex justify-between items-center text-xs text-gray-500">
          <span>public balance (aztec)</span>
          <div className="flex items-center gap-2">
            <span>{formatTokenAmount(publicBalance)} USDC</span>
            {publicBalance > 0n && (
              <button
                onClick={handleTransferToPrivate}
                disabled={isTransferringToPrivate}
                className="text-purple-500 hover:text-purple-400 disabled:opacity-50"
                title="Move public balance to private"
              >
                {isTransferringToPrivate ? '...' : '→ private'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Base Wallet - Blue accent */}
      <div className="border border-blue-900/50 bg-blue-950/10 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-blue-500"></div>
          <div className="text-sm text-blue-400 uppercase tracking-wide">base</div>
        </div>

        {/* Base Balance */}
        <div className="text-center py-4 border border-blue-900/30 bg-blue-950/20">
          <div className="text-2xl text-white">{formatTokenAmount(baseBalance)}</div>
          <div className="text-sm text-blue-400 mt-1">USDC</div>
        </div>

        {!isEvmConnected && (
          <div className="text-xs text-gray-500 text-center">connect base wallet to see balance</div>
        )}
      </div>

      {/* Fund Account Section */}
      {!showTopUp ? (
        <button
          onClick={() => setShowTopUp(true)}
          className="w-full py-3 border border-purple-900/50 hover:border-purple-500 text-purple-400 hover:text-purple-300 transition-colors"
        >
          bridge base → aztec (shield)
        </button>
      ) : (
        <div className="space-y-4 border border-gray-800 p-4">
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-500">bridge usdc to aztec private</span>
            <button
              onClick={() => setShowTopUp(false)}
              className="text-xs text-gray-600 hover:text-gray-400"
            >
              cancel
            </button>
          </div>

          {/* Connect Base if needed */}
          {!isEvmConnected ? (
            <div className="space-y-3">
              <p className="text-xs text-gray-600">connect base wallet to bridge</p>
              <ConnectButton.Custom>
                {({ openConnectModal }) => (
                  <button
                    onClick={openConnectModal}
                    className="w-full py-2 border border-blue-900 hover:border-blue-500 text-blue-400 text-sm"
                  >
                    connect base wallet
                  </button>
                )}
              </ConnectButton.Custom>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Base Balance with Faucet */}
              <div className="flex justify-between text-xs">
                <span className="text-gray-600">available on base</span>
                <div className="flex items-center gap-2">
                  <span className="text-blue-400">{formatTokenAmount(baseBalance)} USDC</span>
                  <button
                    onClick={handleFaucet}
                    disabled={isFauceting || !isBaseFaucetAvailable()}
                    className="text-gray-500 hover:text-gray-300 disabled:opacity-50"
                  >
                    {isFauceting ? '...' : '+faucet'}
                  </button>
                </div>
              </div>

              {/* Amount Input */}
              <div className="flex border border-gray-800 focus-within:border-purple-900">
                <input
                  type="text"
                  value={topUpAmount}
                  onChange={(e) => setTopUpAmount(e.target.value)}
                  placeholder="0.00"
                  className="flex-1 bg-transparent px-3 py-2 outline-none text-white text-sm"
                />
                <button
                  onClick={() => setTopUpAmount(formatTokenAmount(baseBalance).split('.')[0])}
                  className="px-3 py-2 text-xs text-gray-600 hover:text-gray-400"
                >
                  max
                </button>
              </div>

              {/* Shield Button */}
              <button
                onClick={handleTopUp}
                disabled={isTopingUp || !topUpAmount}
                className="w-full py-2 border border-purple-900 hover:border-purple-500 text-purple-400 hover:text-purple-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-sm"
              >
                {isTopingUp ? 'processing...' : 'shield to aztec'}
              </button>

              {/* Progress Stages */}
              {(stage !== 'idle' || baseTxHash) && (
                <div className="border border-gray-800 p-3 space-y-2">
                  <div className="flex justify-between items-center">
                    <div className="text-xs text-gray-500 uppercase">top up progress</div>
                    {orderId && (
                      <div className="text-xs text-gray-600 font-mono">
                        {orderId.slice(0, 8)}...
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    {/* Stage 1: Open on Base */}
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`w-4 h-4 flex items-center justify-center border ${
                        stage === 'opening' ? 'border-gray-400 text-gray-300' :
                        ['waiting_filler', 'claiming', 'complete'].includes(stage) ? 'border-green-600 text-green-500' :
                        'border-gray-800 text-gray-700'
                      }`}>
                        {['waiting_filler', 'claiming', 'complete'].includes(stage) ? '✓' : '1'}
                      </span>
                      <span className={
                        ['waiting_filler', 'claiming', 'complete'].includes(stage) ? 'text-green-500' :
                        stage === 'opening' ? 'text-gray-300' :
                        'text-gray-700'
                      }>
                        {stage === 'opening' ? 'sending USDC to solver on base...' : 'base transfer confirmed'}
                      </span>
                    </div>

                    {/* Stage 2: Waiting for Filler */}
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`w-4 h-4 flex items-center justify-center border ${
                        stage === 'waiting_filler' ? 'border-gray-400 text-gray-300' :
                        ['claiming', 'complete'].includes(stage) ? 'border-green-600 text-green-500' :
                        'border-gray-800 text-gray-700'
                      }`}>
                        {['claiming', 'complete'].includes(stage) ? '✓' : '2'}
                      </span>
                      <span className={
                        ['claiming', 'complete'].includes(stage) ? 'text-green-500' :
                        stage === 'waiting_filler' ? 'text-gray-300' :
                        'text-gray-700'
                      }>
                        {stage === 'waiting_filler' ? (
                          <>waiting for filler...{waitingTime > 0 && <span className="text-gray-500 ml-1">({waitingTime}s)</span>}</>
                        ) : ['claiming', 'complete'].includes(stage) ? 'solver responded' : 'wait for solver'}
                      </span>
                    </div>

                    {/* Stage 3: Claim on Aztec */}
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`w-4 h-4 flex items-center justify-center border ${
                        stage === 'claiming' ? 'border-gray-400 text-gray-300' :
                        stage === 'complete' ? 'border-green-600 text-green-500' :
                        'border-gray-800 text-gray-700'
                      }`}>
                        {stage === 'complete' ? '✓' : '3'}
                      </span>
                      <span className={
                        stage === 'complete' ? 'text-green-500' :
                        stage === 'claiming' ? 'text-gray-300' :
                        'text-gray-700'
                      }>
                        {stage === 'claiming' ? 'private fill confirmed on aztec...' :
                         stage === 'complete' ? 'private balance received' :
                         'receive private fill'}
                      </span>
                    </div>
                  </div>

                  {/* Transaction Hashes */}
                  {(baseTxHash || aztecTxHash) && (
                    <div className="text-xs text-gray-600 pt-2 border-t border-gray-800 space-y-1">
                      {baseTxHash && (
                        <div>base tx: <a href={`https://basescan.org/tx/${baseTxHash}`} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-gray-300 underline">{baseTxHash.slice(0, 10)}...{baseTxHash.slice(-8)}</a></div>
                      )}
                      {aztecTxHash && (
                        <div>aztec tx: <a href={`https://devnet.aztecscan.xyz/tx-effects/${aztecTxHash}`} target="_blank" rel="noopener noreferrer" className="text-green-500 hover:text-green-300 underline">{aztecTxHash.slice(0, 10)}...{aztecTxHash.slice(-8)}</a></div>
                      )}
                    </div>
                  )}

                  {/* Cancel button */}
                  {stage !== 'idle' && stage !== 'complete' && (
                    <div className="pt-2 border-t border-gray-800">
                      <button
                        onClick={handleCancelFlow}
                        className="w-full py-1 text-xs border border-red-900 hover:border-red-600 text-red-500 hover:text-red-400"
                      >
                        cancel flow
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Success Banner */}
          {lastCompleted && (
            <div className="border border-green-800 bg-green-950/20 p-3 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs text-green-400 uppercase">shield complete</span>
                <button
                  onClick={() => setLastCompleted(null)}
                  className="text-xs text-gray-600 hover:text-gray-400"
                >
                  dismiss
                </button>
              </div>
              <div className="text-sm text-green-300">
                {lastCompleted.amount} USDC shielded to aztec
              </div>
              <div className="text-xs text-gray-600 space-y-1">
                {lastCompleted.baseTxHash && (
                  <div>base tx: <a href={`https://basescan.org/tx/${lastCompleted.baseTxHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-300 underline">{lastCompleted.baseTxHash.slice(0, 10)}...{lastCompleted.baseTxHash.slice(-8)}</a></div>
                )}
                {lastCompleted.aztecTxHash && (
                  <div>aztec tx: <a href={`https://devnet.aztecscan.xyz/tx-effects/${lastCompleted.aztecTxHash}`} target="_blank" rel="noopener noreferrer" className="text-green-500 hover:text-green-300 underline">{lastCompleted.aztecTxHash.slice(0, 10)}...{lastCompleted.aztecTxHash.slice(-8)}</a></div>
                )}
                {lastCompleted.orderId && (
                  <div className="text-gray-700">order: {lastCompleted.orderId.slice(0, 10)}...{lastCompleted.orderId.slice(-8)}</div>
                )}
              </div>
            </div>
          )}

          {/* Status/Error */}
          {status && <p className="text-xs text-gray-500">{status}</p>}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      )}

      {/* Info */}
      <div className="text-xs text-gray-600 space-y-1 p-4 border border-gray-900 bg-gray-950/50">
        <p><span className="text-purple-400">aztec:</span> private balance - only you can see or spend</p>
        <p><span className="text-blue-400">base:</span> public balance - bridge to aztec for privacy</p>
      </div>
    </div>
  );
}
