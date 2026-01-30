'use client';

import { useState, useEffect, useRef } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useWalletStore } from '@/stores/walletStore';
import { useFlowStore } from '@/stores/flowStore';
import {
  createBridge,
  executeShield,
  formatTokenAmount,
  parseTokenAmount,
  getAztecAddressFromAzguardAccount,
  isConfigured,
  TOKENS,
} from '@/lib/bridge';
import { executeAzguardCall } from '@/lib/aztec/azguardHelpers';
import type { BridgeFlowState, BridgeStatus } from '@/lib/bridge/types';
import { padHex } from 'viem';

// LocalStorage key for persisting flow state
const FLOW_STORAGE_KEY = 'zkzkp2p-shield-flow';

interface PrivateAccountProps {
  privateBalance: bigint;
  publicBalance: bigint;
  baseBalance: bigint;
  isEvmConnected: boolean;
  onTopUp: () => void;
}

// Shield flow stages (Substance bridge flow)
type ShieldStage =
  | 'idle'
  | 'opening'         // Opening order on Base
  | 'waiting_filler'  // Waiting for filler to fill on Aztec
  | 'claiming'        // Claiming private tokens
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
      const statusToStage: Record<BridgeStatus, ShieldStage> = {
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

  const { address: evmAddress } = useAccount();
  const { aztecAddress, aztecCaipAccount, azguardClient, setAztecTxPending } = useWalletStore();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

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
    if (!walletClient || !publicClient || !TOKENS.base.address) return;

    setIsFauceting(true);
    setError(null);
    setStatus('calling faucet...');

    try {
      // Simple faucet call - mint test USDC
      // Note: This assumes the token has a mint function for testnet
      const { request } = await publicClient.simulateContract({
        address: TOKENS.base.address as `0x${string}`,
        abi: [
          {
            name: 'mint',
            type: 'function',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [],
          },
        ],
        functionName: 'mint',
        args: [evmAddress!, BigInt(1000) * BigInt(10 ** 6)], // 1000 USDC
        account: evmAddress,
      });
      await walletClient.writeContract(request);
      setStatus('faucet complete');
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
    if (!walletClient || !publicClient || !evmAddress || !aztecAddress || !aztecCaipAccount || !azguardClient) {
      setError('wallets not connected');
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

    if (!isConfigured()) {
      setError('bridge not configured - check token addresses');
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
      // Create bridge instance
      console.log('[TopUp] Creating bridge instance...');
      const bridge = await createBridge({
        azguardClient,
        evmProvider: walletClient,
      });

      // Get Aztec address from CAIP account (padded to 32 bytes)
      const aztecAddr = getAztecAddressFromAzguardAccount(aztecCaipAccount as `aztec:${number}:${string}`);
      const paddedAztecAddr = padHex(aztecAddr as `0x${string}`, { size: 32 });

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

      // Execute shield flow (Base -> Aztec)
      setStage('opening');
      console.log('[TopUp] Executing shield flow...');

      const onProgress = (state: Partial<BridgeFlowState>) => {
        console.log('[TopUp] Progress:', state.status);

        if (state.status) {
          const statusToStage: Record<BridgeStatus, ShieldStage> = {
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
          setBaseTxHash(state.txHashes.open);
        }

        if (state.txHashes?.claim) {
          setAztecTxHash(state.txHashes.claim);
        }

        // Start timer when waiting for filler
        if (state.status === 'waiting_filler' && !waitingTimerRef.current) {
          waitingTimerRef.current = setInterval(() => {
            setWaitingTime(prev => prev + 1);
          }, 1000);
        }

        // Update store
        updateShieldFlow({
          status: state.status,
          orderId: state.orderId,
          txHashes: state.txHashes,
        });
      };

      const result = await executeShield({
        bridge,
        amount,
        aztecRecipient: paddedAztecAddr,
        onProgress,
      });

      console.log('[TopUp] Shield complete:', result);

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
        baseTxHash,
        aztecTxHash,
        orderId,
        amount: topUpAmount,
      });
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

  // Transfer public balance to private (if any leftover)
  const handleTransferToPrivate = async () => {
    if (!azguardClient || !aztecCaipAccount || publicBalance <= 0n) return;

    setIsTransferringToPrivate(true);
    setError(null);
    setStatus('transferring to private...');

    try {
      // Extract plain address from CAIP account
      const userAddress = aztecCaipAccount.split(':').pop()!;

      console.log('[PrivateAccount] Transferring', publicBalance.toString(), 'from public to private');

      // Call the token contract's transfer_public_to_private function
      // Args: from, to, amount, nonce (nonce=0 for non-authwit calls)
      const txHash = await executeAzguardCall(
        azguardClient,
        aztecCaipAccount,
        TOKENS.aztec.address,
        'transfer_public_to_private',
        [userAddress, userAddress, publicBalance.toString(), '0']
      );

      console.log('[PrivateAccount] Transfer tx hash:', txHash);
      setStatus('transferred to private');
      setTimeout(() => {
        setStatus(null);
        onTopUp(); // Refresh balances
      }, 2000);
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
          <div className="text-sm text-blue-400 uppercase tracking-wide">base sepolia</div>
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
                    disabled={isFauceting}
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
                        {stage === 'opening' ? 'opening order on base...' : 'order opened'}
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
                        ) : ['claiming', 'complete'].includes(stage) ? 'filler responded' : 'wait for filler'}
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
                        {stage === 'claiming' ? 'claiming on aztec...' :
                         stage === 'complete' ? 'private balance received' :
                         'claim tokens'}
                      </span>
                    </div>
                  </div>

                  {/* Transaction Hashes */}
                  {(baseTxHash || aztecTxHash) && (
                    <div className="text-xs text-gray-600 pt-2 border-t border-gray-800 space-y-1">
                      {baseTxHash && (
                        <div>base tx: <a href={`https://sepolia.basescan.org/tx/${baseTxHash}`} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-gray-300 underline">{baseTxHash.slice(0, 10)}...{baseTxHash.slice(-8)}</a></div>
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
                  <div>base tx: <a href={`https://sepolia.basescan.org/tx/${lastCompleted.baseTxHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-300 underline">{lastCompleted.baseTxHash.slice(0, 10)}...{lastCompleted.baseTxHash.slice(-8)}</a></div>
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
