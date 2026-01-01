'use client';

import { useState, useEffect, useRef } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useWalletStore } from '@/stores/walletStore';
import { formatTokenAmount, callFaucet, notifySolver } from '@/lib/train/evm';
import { parseAmount, transferToPrivate, getAztecPublicBalance } from '@/lib/train/deposit';
import { checkForSolverLock, getAztecBlockNumber } from '@/lib/aztec/aztecReadClient';
import { initShieldFlow, lockOnBaseForShield, redeemOnAztec, redeemAndTransferToPrivate, transferToPrivateAfterRedeem, type ShieldFlowState } from '@/lib/train/shield';
import { BASE_TOKEN_ADDRESS, AZTEC_TRAIN_ADDRESS } from '@/lib/train/contracts';
import { registerAzguardContract } from '@/lib/aztec/azguardHelpers';

// LocalStorage key for persisting flow state
const FLOW_STORAGE_KEY = 'zkzkp2p-shield-flow';

interface PrivateAccountProps {
  privateBalance: bigint;
  publicBalance: bigint;
  baseBalance: bigint;
  isEvmConnected: boolean;
  onTopUp: () => void;
}

// Solver address for testnet
const SOLVER_EVM_ADDRESS = (process.env.NEXT_PUBLIC_SOLVER_EVM_ADDRESS || '0x8ff2c11118ed9c7839b03dc9f4d4d6a479de3c95') as `0x${string}`;

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
  const [stage, setStage] = useState<'idle' | 'locking_base' | 'waiting_solver' | 'claiming_aztec' | 'transferring_private' | 'complete'>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [aztecTxHash, setAztecTxHash] = useState<string | null>(null);
  const [flowState, setFlowState] = useState<ShieldFlowState | null>(null);
  const [lockBlockNumber, setLockBlockNumber] = useState<number>(0);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [isClaimingAztec, setIsClaimingAztec] = useState(false);
  const [claimPaused, setClaimPaused] = useState(false); // Pause auto-claim after rejection
  const [isTransferringToPrivate, setIsTransferringToPrivate] = useState(false);

  // Load persisted flow state on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(FLOW_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Convert bigint strings back to bigint
        const restored: ShieldFlowState = {
          ...parsed,
          amount: BigInt(parsed.amount),
          secretHigh: BigInt(parsed.secretHigh),
          secretLow: BigInt(parsed.secretLow),
          hashlockHigh: BigInt(parsed.hashlockHigh),
          hashlockLow: BigInt(parsed.hashlockLow),
        };
        const restoredStage = parsed.savedStage || 'waiting_solver';
        setFlowState(restored);
        setStage(restoredStage);
        setTxHash(parsed.savedTxHash || null);
        setLockBlockNumber(parsed.savedLockBlock || 1);
        setShowTopUp(true); // Show the panel for in-progress flow

        // If restoring at claiming stage, pause auto-claim so user has control
        // This prevents auto-retry loops when restoring after errors/refreshes
        if (restoredStage === 'claiming_aztec') {
          setClaimPaused(true);
          console.log('[TopUp] Restored at claiming stage - paused for manual retry');
        }

        console.log('[TopUp] Restored flow state from localStorage:', restored.swapId, 'stage:', restoredStage);
      }
    } catch (err) {
      console.error('[TopUp] Failed to restore flow state:', err);
      localStorage.removeItem(FLOW_STORAGE_KEY);
    }
  }, []);

  // Save flow state whenever it changes
  useEffect(() => {
    if (flowState && stage !== 'idle' && stage !== 'complete') {
      try {
        const toSave = {
          ...flowState,
          // Convert bigints to strings for JSON
          amount: flowState.amount.toString(),
          secretHigh: flowState.secretHigh.toString(),
          secretLow: flowState.secretLow.toString(),
          hashlockHigh: flowState.hashlockHigh.toString(),
          hashlockLow: flowState.hashlockLow.toString(),
          savedStage: stage,
          savedTxHash: txHash,
          savedLockBlock: lockBlockNumber,
        };
        localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(toSave));
      } catch (err) {
        console.error('[TopUp] Failed to save flow state:', err);
      }
    } else if (stage === 'complete' || stage === 'idle') {
      // Clear saved state when done
      localStorage.removeItem(FLOW_STORAGE_KEY);
    }
  }, [flowState, stage, txHash, lockBlockNumber]);

  const { address: evmAddress } = useAccount();
  const { aztecAddress, aztecCaipAccount, azguardClient } = useWalletStore();
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

  // Poll Aztec node directly for solver lock (no Azguard needed)
  useEffect(() => {
    if (stage !== 'waiting_solver' || !flowState?.swapId || lockBlockNumber === 0) return;

    console.log('[TopUp] Polling Aztec node for solver lock...');

    const checkLock = async () => {
      try {
        const found = await checkForSolverLock(flowState.swapId, lockBlockNumber);

        if (found) {
          console.log('[TopUp] Solver locked on Aztec! Starting claim...');
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          // Trigger claim on Aztec
          setStage('claiming_aztec');
        }
      } catch (err) {
        console.error('[TopUp] Error checking solver lock:', err);
      }
    };

    // Check immediately
    checkLock();

    // Then poll every 10 seconds (direct RPC, no Azguard popups)
    pollIntervalRef.current = setInterval(checkLock, 10000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [stage, flowState?.swapId, lockBlockNumber]);

  // Helper to detect AlreadyClaimed error (means previous claim succeeded)
  const isAlreadyClaimedError = (error: any): boolean => {
    const message = error?.message?.toLowerCase() || '';
    return message.includes('alreadyclaimed') || message.includes('already claimed') || message.includes('already redeemed');
  };

  // Claim on Aztec when stage becomes claiming_aztec (unless paused)
  // Uses combined redeem + transfer_to_private in single tx for better UX
  useEffect(() => {
    if (stage !== 'claiming_aztec' || !flowState || !azguardClient || !aztecCaipAccount || isClaimingAztec || claimPaused) return;

    const claimOnAztec = async () => {
      setIsClaimingAztec(true);
      console.log('[TopUp] Redeeming and transferring to private (single tx)...');

      try {
        // Ensure Train contract is registered with Azguard (fetches artifact from Aztec network)
        if (AZTEC_TRAIN_ADDRESS) {
          console.log('[TopUp] Registering Train contract with Azguard...');
          await registerAzguardContract(azguardClient, AZTEC_TRAIN_ADDRESS);
          console.log('[TopUp] Train contract registered successfully');
        }

        // Combined: redeem + transfer_to_private in single transaction
        const claimTxHash = await redeemAndTransferToPrivate(azguardClient, aztecCaipAccount, flowState);
        console.log('[TopUp] Redeem + transfer to private successful:', claimTxHash);

        setAztecTxHash(claimTxHash);
        setIsClaimingAztec(false);

        // Skip transferring_private stage - already done in batch
        localStorage.removeItem(FLOW_STORAGE_KEY);
        setStage('complete');
        setTimeout(() => onTopUp(), 2000); // Refresh balances
      } catch (err) {
        console.error('[TopUp] Error claiming on Aztec:', err);

        // Check if this is an "AlreadyClaimed" error - means previous claim succeeded!
        if (isAlreadyClaimedError(err)) {
          console.log('[TopUp] HTLC already claimed - checking if transfer needed');
          setAztecTxHash('previously-claimed');
          setIsClaimingAztec(false);
          setError(null);
          // Move to transfer stage in case public balance still needs moving
          setStage('transferring_private');
          return;
        }

        if (isUserRejection(err)) {
          // User cancelled - pause auto-claim so they can manually retry
          setClaimPaused(true);
          setIsClaimingAztec(false);
        } else {
          setError(err instanceof Error ? err.message : 'claim failed');
          setClaimPaused(true); // Pause on error too
          setIsClaimingAztec(false);
        }
      }
    };

    claimOnAztec();
  }, [stage, flowState, azguardClient, aztecCaipAccount, isClaimingAztec, claimPaused, onTopUp]);

  // Transfer to private when stage becomes transferring_private
  useEffect(() => {
    if (stage !== 'transferring_private' || !flowState || !azguardClient || !aztecCaipAccount || isTransferringToPrivate) return;

    const doTransferToPrivate = async () => {
      setIsTransferringToPrivate(true);
      console.log('[TopUp] Transferring to private balance...');

      try {
        // Wait a bit for redeem state to propagate
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Query actual public balance to avoid underflow errors
        let amountToTransfer = flowState.amount;
        try {
          const actualBalance = await getAztecPublicBalance(azguardClient, aztecCaipAccount);
          if (actualBalance !== null && actualBalance > 0n) {
            amountToTransfer = actualBalance;
            console.log('[TopUp] Using actual public balance:', amountToTransfer.toString());
          } else {
            console.log('[TopUp] Balance query returned null or 0, using flow amount:', flowState.amount.toString());
          }
        } catch (e) {
          console.log('[TopUp] Could not query balance, using flow amount:', flowState.amount.toString());
        }

        const transferTxHash = await transferToPrivateAfterRedeem(azguardClient, aztecCaipAccount, amountToTransfer);
        console.log('[TopUp] Transfer to private successful:', transferTxHash);

        // Clear localStorage and mark complete
        localStorage.removeItem(FLOW_STORAGE_KEY);
        setStage('complete');
        // Refresh balances
        setTimeout(() => onTopUp(), 2000);
      } catch (err) {
        console.error('[TopUp] Error transferring to private:', err);

        if (isUserRejection(err)) {
          // User cancelled - they can use the manual "→ private" button later
          // Still mark as complete since redeem succeeded
          localStorage.removeItem(FLOW_STORAGE_KEY);
          setStage('complete');
          setStatus('redeemed (use → private button to move to private balance)');
          setTimeout(() => onTopUp(), 1000);
        } else {
          setError(err instanceof Error ? err.message : 'transfer to private failed');
          // Still mark complete - redeem succeeded, user can manually transfer
          localStorage.removeItem(FLOW_STORAGE_KEY);
          setStage('complete');
          setTimeout(() => onTopUp(), 1000);
        }
      } finally {
        setIsTransferringToPrivate(false);
      }
    };

    doTransferToPrivate();
  }, [stage, flowState, azguardClient, aztecCaipAccount, isTransferringToPrivate, onTopUp]);

  // Manual retry claim
  const handleRetryClaim = () => {
    setClaimPaused(false);
    setIsClaimingAztec(false);
    setError(null);
  };

  // Cancel/reset the entire flow
  const handleCancelFlow = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setStage('idle');
    setFlowState(null);
    setTxHash(null);
    setAztecTxHash(null);
    setError(null);
    setClaimPaused(false);
    setIsClaimingAztec(false);
    setLockBlockNumber(0);
    localStorage.removeItem(FLOW_STORAGE_KEY);
    console.log('[TopUp] Flow cancelled and reset');
  };

  const handleFaucet = async () => {
    if (!walletClient || !publicClient || !BASE_TOKEN_ADDRESS) return;

    setIsFauceting(true);
    setError(null);
    setStatus('calling faucet...');

    try {
      await callFaucet(walletClient, publicClient, BASE_TOKEN_ADDRESS as `0x${string}`);
      setStatus('faucet complete');
      onTopUp();
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      if (isUserRejection(err)) {
        setStatus(null); // Silently ignore user rejections
      } else {
        setError(err instanceof Error ? err.message : 'faucet failed');
        setStatus(null);
      }
    } finally {
      setIsFauceting(false);
    }
  };

  const handleTopUp = async () => {
    if (!walletClient || !publicClient || !evmAddress || !aztecAddress) {
      setError('base wallet not connected');
      return;
    }

    const amount = parseAmount(topUpAmount);
    if (amount <= 0n) {
      setError('enter an amount');
      return;
    }

    if (baseBalance < amount) {
      setError('insufficient base balance');
      return;
    }

    setIsTopingUp(true);
    setError(null);
    setTxHash(null);
    setStage('idle');
    setFlowState(null);
    setIsClaimingAztec(false);

    try {
      // Step 1: Lock on Base
      setStage('locking_base');
      const flow = await initShieldFlow(amount);

      const baseTxHash = await lockOnBaseForShield(
        walletClient,
        publicClient,
        evmAddress,
        aztecAddress,
        SOLVER_EVM_ADDRESS,
        flow
      );

      setTxHash(baseTxHash);

      console.log('[TopUp] Base lock complete:', baseTxHash);
      console.log('[TopUp] Swap ID:', flow.swapId);
      console.log('[TopUp] Hashlock:', flow.hashlockHigh.toString(), flow.hashlockLow.toString());

      // Get current Aztec block to poll from
      const aztecBlock = await getAztecBlockNumber();
      setLockBlockNumber(aztecBlock);
      console.log('[TopUp] Starting Aztec poll from block:', aztecBlock);

      // Notify solver for faster processing (non-blocking)
      notifySolver({
        swapId: flow.swapId,
        direction: 'base_to_aztec',
        amount: flow.amount,
        hashlockHigh: flow.hashlockHigh,
        hashlockLow: flow.hashlockLow,
        userAddress: aztecAddress,
      }).catch(() => {}); // Ignore errors - solver will detect via events

      // Step 2: Wait for solver to lock on Aztec
      // Store full flow state (includes secrets needed for claiming)
      setFlowState(flow);
      setStage('waiting_solver');

      // Polling will start automatically via useEffect when stage changes to 'waiting_solver'
      console.log('[TopUp] Waiting for solver to lock on Aztec...');

    } catch (err) {
      if (isUserRejection(err)) {
        // User cancelled - reset quietly
        setStage('idle');
        setStatus(null);
        setError(null);
        setFlowState(null);
      } else {
        setError(err instanceof Error ? err.message : 'top up failed');
        setStage('idle');
      }
    } finally {
      setIsTopingUp(false);
    }
  };

  // Transfer public balance to private
  const handleTransferToPrivate = async () => {
    if (!azguardClient || !aztecCaipAccount || publicBalance <= 0n) return;

    setIsTransferringToPrivate(true);
    setError(null);
    setStatus('transferring to private...');

    try {
      console.log('[PrivateAccount] Transferring', publicBalance.toString(), 'from public to private...');
      const txHash = await transferToPrivate(azguardClient, aztecCaipAccount, publicBalance);
      console.log('[PrivateAccount] Transfer to private tx:', txHash);
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
    <div className="border border-gray-800 p-6 space-y-6">
      <div className="text-sm text-gray-500 uppercase tracking-wide">private account</div>

      {/* Balance Display */}
      <div className="space-y-4">
        <div className="text-center py-6 border border-gray-800">
          <div className="text-3xl text-white">{formatTokenAmount(privateBalance)}</div>
          <div className="text-sm text-gray-600 mt-1">USDC</div>
        </div>

        <div className="flex justify-between items-center text-xs text-gray-600">
          <span>public balance</span>
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

      {/* Fund Account Section */}
      {!showTopUp ? (
        <button
          onClick={() => setShowTopUp(true)}
          className="w-full py-3 border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white transition-colors"
        >
          fund private account (aztec)
        </button>
      ) : (
        <div className="space-y-4 border border-gray-800 p-4">
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-500">fund from base</span>
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
              <p className="text-xs text-gray-600">connect base wallet to top up</p>
              <ConnectButton.Custom>
                {({ openConnectModal }) => (
                  <button
                    onClick={openConnectModal}
                    className="w-full py-2 border border-gray-700 hover:border-gray-500 text-sm"
                  >
                    connect base wallet
                  </button>
                )}
              </ConnectButton.Custom>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Base Balance */}
              <div className="flex justify-between text-xs">
                <span className="text-gray-600">base balance</span>
                <div className="flex items-center gap-2">
                  <span>{formatTokenAmount(baseBalance)} USDC</span>
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
              <div className="flex border border-gray-800 focus-within:border-gray-600">
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

              {/* Top Up Button */}
              <button
                onClick={handleTopUp}
                disabled={isTopingUp || !topUpAmount}
                className="w-full py-2 border border-gray-600 hover:border-white hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-sm"
              >
                {isTopingUp ? 'processing...' : 'top up'}
              </button>

              {/* Progress Stages */}
              {(stage !== 'idle' || txHash) && (
                <div className="border border-gray-800 p-3 space-y-2">
                  <div className="text-xs text-gray-500 uppercase">top up progress</div>
                  <div className="space-y-2">
                    {/* Stage 1: Lock on Base */}
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`w-4 h-4 flex items-center justify-center border ${
                        stage === 'locking_base' ? 'border-gray-400 text-gray-300' :
                        ['waiting_solver', 'claiming_aztec', 'transferring_private', 'complete'].includes(stage) ? 'border-green-600 text-green-500' :
                        'border-gray-800 text-gray-700'
                      }`}>
                        {['waiting_solver', 'claiming_aztec', 'transferring_private', 'complete'].includes(stage) ? '✓' : '1'}
                      </span>
                      <span className={
                        ['waiting_solver', 'claiming_aztec', 'transferring_private', 'complete'].includes(stage) ? 'text-green-500' :
                        stage === 'locking_base' ? 'text-gray-300' :
                        'text-gray-700'
                      }>
                        {stage === 'locking_base' ? 'locking on base...' : 'locked on base'}
                      </span>
                    </div>

                    {/* Stage 2: Waiting for Solver */}
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`w-4 h-4 flex items-center justify-center border ${
                        stage === 'waiting_solver' ? 'border-gray-400 text-gray-300' :
                        ['claiming_aztec', 'transferring_private', 'complete'].includes(stage) ? 'border-green-600 text-green-500' :
                        'border-gray-800 text-gray-700'
                      }`}>
                        {['claiming_aztec', 'transferring_private', 'complete'].includes(stage) ? '✓' : '2'}
                      </span>
                      <span className={
                        ['claiming_aztec', 'transferring_private', 'complete'].includes(stage) ? 'text-green-500' :
                        stage === 'waiting_solver' ? 'text-gray-300' :
                        'text-gray-700'
                      }>
                        {stage === 'waiting_solver' ? 'waiting for solver...' :
                         ['claiming_aztec', 'transferring_private', 'complete'].includes(stage) ? 'solver locked' :
                         'wait for solver'}
                      </span>
                    </div>

                    {/* Stage 3: Redeem on Aztec */}
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`w-4 h-4 flex items-center justify-center border ${
                        stage === 'claiming_aztec' ? 'border-gray-400 text-gray-300' :
                        ['transferring_private', 'complete'].includes(stage) ? 'border-green-600 text-green-500' :
                        'border-gray-800 text-gray-700'
                      }`}>
                        {['transferring_private', 'complete'].includes(stage) ? '✓' : '3'}
                      </span>
                      <span className={
                        ['transferring_private', 'complete'].includes(stage) ? 'text-green-500' :
                        stage === 'claiming_aztec' ? 'text-gray-300' :
                        'text-gray-700'
                      }>
                        {stage === 'claiming_aztec' ? 'redeeming...' :
                         ['transferring_private', 'complete'].includes(stage) ? 'redeemed' :
                         'redeem'}
                      </span>
                    </div>

                    {/* Stage 4: Transfer to Private */}
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`w-4 h-4 flex items-center justify-center border ${
                        stage === 'transferring_private' ? 'border-gray-400 text-gray-300' :
                        stage === 'complete' ? 'border-green-600 text-green-500' :
                        'border-gray-800 text-gray-700'
                      }`}>
                        {stage === 'complete' ? '✓' : '4'}
                      </span>
                      <span className={
                        stage === 'complete' ? 'text-green-500' :
                        stage === 'transferring_private' ? 'text-gray-300' :
                        'text-gray-700'
                      }>
                        {stage === 'transferring_private' ? 'moving to private...' :
                         stage === 'complete' ? 'private balance' :
                         'to private'}
                      </span>
                    </div>
                  </div>

                  {/* Transaction Hashes */}
                  {(txHash || aztecTxHash) && (
                    <div className="text-xs text-gray-600 pt-2 border-t border-gray-800 space-y-1">
                      {txHash && (
                        <div>base tx: <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-gray-300 underline">{txHash.slice(0, 10)}...{txHash.slice(-8)}</a></div>
                      )}
                      {aztecTxHash && (
                        <div>aztec tx: {aztecTxHash === 'previously-claimed' ? (
                          <span className="text-green-500">(already claimed)</span>
                        ) : (
                          <a href={`https://devnet.aztecscan.xyz/tx-effects/${aztecTxHash}`} target="_blank" rel="noopener noreferrer" className="text-green-500 hover:text-green-300 underline">{aztecTxHash.slice(0, 10)}...{aztecTxHash.slice(-8)}</a>
                        )}</div>
                      )}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex gap-2 pt-2 border-t border-gray-800">
                    {/* Retry button - shown when claim is paused */}
                    {claimPaused && stage === 'claiming_aztec' && (
                      <button
                        onClick={handleRetryClaim}
                        className="flex-1 py-1 text-xs border border-gray-600 hover:border-white text-gray-400 hover:text-white"
                      >
                        retry claim
                      </button>
                    )}
                    {/* Cancel button - shown during active flow */}
                    {stage !== 'idle' && stage !== 'complete' && (
                      <button
                        onClick={handleCancelFlow}
                        className="flex-1 py-1 text-xs border border-red-900 hover:border-red-600 text-red-500 hover:text-red-400"
                      >
                        cancel flow
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Status/Error */}
          {status && <p className="text-xs text-gray-500">{status}</p>}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      )}

      {/* Info */}
      <div className="text-xs text-gray-700 space-y-1 pt-4 border-t border-gray-900">
        <p>your private balance is shielded on aztec network</p>
        <p>only you can see or spend these funds</p>
      </div>
    </div>
  );
}
