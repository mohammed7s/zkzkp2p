'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { useWalletStore } from '@/stores/walletStore';
import { useFlowStore } from '@/stores/flowStore';
import { parseAmount, formatAmount } from '@/lib/train/deposit';
import { getBaseUSDCBalance, callFaucet, formatTokenAmount } from '@/lib/train/evm';
import { initShieldFlow, lockOnBaseForShield, getAztecPrivateBalance, type ShieldFlowState } from '@/lib/train/shield';
import {
  initDepositFlow,
  setAuthwit,
  lockOnAztec,
  getAztecPublicBalance,
  transferToPublic,
  type DepositFlowState,
} from '@/lib/train/deposit';
import { BASE_TOKEN_ADDRESS, AZTEC_TOKEN_ADDRESS } from '@/lib/train/contracts';

type Tab = 'shield' | 'deposit';

// Solver addresses from env (or hardcoded fallbacks for testnet)
// These are the addresses that will lock on the opposite chain
const SOLVER_EVM_ADDRESS = (process.env.NEXT_PUBLIC_SOLVER_EVM_ADDRESS || '0x8ff2c11118ed9c7839b03dc9f4d4d6a479de3c95') as `0x${string}`;
const SOLVER_AZTEC_ADDRESS = process.env.NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS || '0x2e867c7b98a3c4a24d5d0e11d8e0fb6aac0d3e76f4b5c8d9e0f1a2b3c4d5e6f7';

export function SwapBox() {
  const [activeTab, setActiveTab] = useState<Tab>('shield');
  const [amount, setAmount] = useState('');
  const { isConnected: isEvmConnected, address: evmAddress } = useAccount();
  const { isAztecConnected, aztecAddress, aztecCaipAccount, azguardClient } = useWalletStore();

  // Balances
  const [baseBalance, setBaseBalance] = useState<bigint>(0n);
  const [aztecPrivateBalance, setAztecPrivateBalance] = useState<bigint>(0n);
  const [aztecPublicBalance, setAztecPublicBalance] = useState<bigint>(0n);
  const [loadingBalances, setLoadingBalances] = useState(false);

  // Clients
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  // Flow state
  const { activeShieldFlow, activeDepositFlow, isExecuting, startShieldFlow, updateShieldFlow, failShieldFlow } = useFlowStore();

  // Fetch balances
  const fetchBalances = useCallback(async () => {
    setLoadingBalances(true);
    try {
      // Fetch Base balance
      if (publicClient && evmAddress && BASE_TOKEN_ADDRESS) {
        try {
          const balance = await getBaseUSDCBalance(publicClient, evmAddress);
          setBaseBalance(balance);
        } catch (err) {
          console.error('[Balance] Failed to fetch Base balance:', err);
          setBaseBalance(0n);
        }
      } else {
        setBaseBalance(0n);
      }

      // Fetch Aztec balances - use CAIP account for Azguard operations
      if (azguardClient && aztecCaipAccount && AZTEC_TOKEN_ADDRESS) {
        try {
          const privateBalance = await getAztecPrivateBalance(azguardClient, aztecCaipAccount);
          if (privateBalance !== null) {
            setAztecPrivateBalance(privateBalance);
          }
        } catch (err) {
          console.error('[Balance] Failed to fetch Aztec private balance:', err);
          setAztecPrivateBalance(0n);
        }
        try {
          const publicBalance = await getAztecPublicBalance(azguardClient, aztecCaipAccount);
          if (publicBalance !== null) {
            setAztecPublicBalance(publicBalance);
          }
        } catch (err) {
          console.error('[Balance] Failed to fetch Aztec public balance:', err);
          setAztecPublicBalance(0n);
        }
      } else {
        setAztecPrivateBalance(0n);
        setAztecPublicBalance(0n);
      }
    } catch (error) {
      console.error('Failed to fetch balances:', error);
    } finally {
      setLoadingBalances(false);
    }
  }, [publicClient, evmAddress, azguardClient, aztecCaipAccount]);

  useEffect(() => {
    fetchBalances();
    // DISABLED: Azguard prompts for private balance queries on each poll
    // TODO: Report to Azguard team - simulate_views should be silent
    // const interval = setInterval(fetchBalances, 30000);
    // return () => clearInterval(interval);
  }, [fetchBalances]);

  const bothConnected = isEvmConnected && isAztecConnected;

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-xl overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-gray-800">
          <button
            onClick={() => setActiveTab('shield')}
            className={`flex-1 py-4 text-sm font-medium transition-colors ${
              activeTab === 'shield'
                ? 'text-white bg-gray-800/50'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            Shield
          </button>
          <button
            onClick={() => setActiveTab('deposit')}
            className={`flex-1 py-4 text-sm font-medium transition-colors ${
              activeTab === 'deposit'
                ? 'text-white bg-gray-800/50'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            Deposit
          </button>
        </div>

        <div className="p-6">
          {activeTab === 'shield' ? (
            <ShieldPanel
              amount={amount}
              setAmount={setAmount}
              isEvmConnected={isEvmConnected}
              isAztecConnected={isAztecConnected}
              baseBalance={baseBalance}
              aztecPrivateBalance={aztecPrivateBalance}
              loadingBalances={loadingBalances}
              fetchBalances={fetchBalances}
            />
          ) : (
            <DepositPanel
              amount={amount}
              setAmount={setAmount}
              isAztecConnected={isAztecConnected}
              aztecAddress={aztecAddress}
              aztecPrivateBalance={aztecPrivateBalance}
              aztecPublicBalance={aztecPublicBalance}
              loadingBalances={loadingBalances}
              fetchBalances={fetchBalances}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ShieldPanel({
  amount,
  setAmount,
  isEvmConnected,
  isAztecConnected,
  baseBalance,
  aztecPrivateBalance,
  loadingBalances,
  fetchBalances,
}: {
  amount: string;
  setAmount: (v: string) => void;
  isEvmConnected: boolean;
  isAztecConnected: boolean;
  baseBalance: bigint;
  aztecPrivateBalance: bigint;
  loadingBalances: boolean;
  fetchBalances: () => Promise<void>;
}) {
  const [status, setStatus] = useState<string>('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { address: evmAddress } = useAccount();
  const { aztecAddress, aztecCaipAccount, azguardClient } = useWalletStore();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const flowStore = useFlowStore();

  const bothConnected = isEvmConnected && isAztecConnected;

  // Base faucet handler (testnet only)
  const handleBaseFaucet = async () => {
    if (!walletClient || !publicClient || !BASE_TOKEN_ADDRESS) {
      setError('Wallet not connected or token address missing');
      return;
    }
    setStatus('Calling Base USDC faucet...');
    setError(null);
    try {
      await callFaucet(walletClient, publicClient, BASE_TOKEN_ADDRESS as `0x${string}`);
      setStatus('Faucet called! Refreshing balance...');
      await fetchBalances();
      setStatus('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Faucet failed';
      setError(`Base faucet error: ${message}`);
      setStatus('');
    }
  };

  // Execute shield flow
  const handleShield = async () => {
    if (!walletClient || !publicClient || !azguardClient || !evmAddress || !aztecAddress) {
      setError('Wallets not connected');
      return;
    }

    const amountBigInt = parseAmount(amount);
    if (amountBigInt <= 0n) {
      setError('Enter a valid amount');
      return;
    }

    setIsExecuting(true);
    setError(null);

    try {
      // Step 1: Initialize flow
      setStatus('Generating secret...');
      const flow = await initShieldFlow(amountBigInt);
      flowStore.startShieldFlow(flow);

      // Step 2: Lock on Base
      setStatus('Locking tokens on Base (approve in wallet)...');
      const baseTxHash = await lockOnBaseForShield(
        walletClient,
        publicClient,
        evmAddress,
        aztecAddress,
        SOLVER_EVM_ADDRESS,
        flow
      );
      flowStore.updateShieldFlow({ baseLockTxHash: baseTxHash, status: 'WAITING_SOLVER' });
      setStatus(`Locked on Base! TX: ${baseTxHash.slice(0, 10)}...`);

      // Step 3: Wait for solver (in real scenario)
      setStatus('Waiting for solver to lock on Aztec... (demo: check manually)');

      // For demo purposes, we complete here
      // In production, this would poll for the Aztec HTLC and then redeem
      setTimeout(() => {
        setStatus('Shield initiated! Solver will complete the bridge.');
        fetchBalances();
      }, 2000);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Shield failed';
      setError(message);
      flowStore.failShieldFlow(message);
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* From Section */}
      <div className="bg-gray-800/50 rounded-xl p-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-gray-400">From (Base)</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">
              {loadingBalances ? 'Loading...' : `Balance: ${formatTokenAmount(baseBalance)}`}
            </span>
            {isEvmConnected && (
              <button
                onClick={handleBaseFaucet}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                Faucet
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-2xl font-medium outline-none placeholder:text-gray-600"
          />
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-700 rounded-lg">
            <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-xs font-bold">$</div>
            <span className="font-medium">USDC</span>
          </div>
        </div>
      </div>

      {/* Arrow */}
      <div className="flex justify-center">
        <div className="w-10 h-10 rounded-full bg-gray-800 border-4 border-gray-900 flex items-center justify-center">
          <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </div>
      </div>

      {/* To Section */}
      <div className="bg-gray-800/50 rounded-xl p-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-gray-400">To (Aztec - Private)</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">
              {loadingBalances ? 'Loading...' : `Balance: ${formatTokenAmount(aztecPrivateBalance)}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={amount}
            readOnly
            placeholder="0.00"
            className="flex-1 bg-transparent text-2xl font-medium outline-none placeholder:text-gray-600 text-purple-400"
          />
          <div className="flex items-center gap-2 px-3 py-2 bg-purple-900/50 rounded-lg">
            <div className="w-6 h-6 rounded-full bg-purple-500 flex items-center justify-center text-xs font-bold">$</div>
            <span className="font-medium text-purple-300">USDC</span>
          </div>
        </div>
      </div>

      {/* Status/Error */}
      {status && (
        <div className="text-sm text-blue-400 bg-blue-900/20 rounded-lg p-3">
          {status}
        </div>
      )}
      {error && (
        <div className="text-sm text-red-400 bg-red-900/20 rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Info */}
      <div className="text-xs text-gray-500 space-y-1">
        <div className="flex justify-between">
          <span>Route</span>
          <span>Base → Train Protocol → Aztec</span>
        </div>
        <div className="flex justify-between">
          <span>Privacy</span>
          <span className="text-purple-400">Fully Private</span>
        </div>
      </div>

      {/* Action Button */}
      {!bothConnected ? (
        <button
          disabled
          className="w-full py-4 rounded-xl font-semibold bg-gray-700 text-gray-400 cursor-not-allowed"
        >
          {!isEvmConnected && !isAztecConnected
            ? 'Connect Wallets'
            : !isEvmConnected
            ? 'Connect Base Wallet'
            : 'Connect Aztec Wallet'}
        </button>
      ) : !amount || parseFloat(amount) <= 0 ? (
        <button
          disabled
          className="w-full py-4 rounded-xl font-semibold bg-gray-700 text-gray-400 cursor-not-allowed"
        >
          Enter Amount
        </button>
      ) : isExecuting ? (
        <button
          disabled
          className="w-full py-4 rounded-xl font-semibold bg-purple-800 text-purple-300 cursor-wait"
        >
          Processing...
        </button>
      ) : (
        <button
          onClick={handleShield}
          className="w-full py-4 rounded-xl font-semibold bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 transition-all"
        >
          Shield to Aztec
        </button>
      )}
    </div>
  );
}

function DepositPanel({
  amount,
  setAmount,
  isAztecConnected,
  aztecAddress,
  aztecPrivateBalance,
  aztecPublicBalance,
  loadingBalances,
  fetchBalances,
}: {
  amount: string;
  setAmount: (v: string) => void;
  isAztecConnected: boolean;
  aztecAddress: string | null;
  aztecPrivateBalance: bigint;
  aztecPublicBalance: bigint;
  loadingBalances: boolean;
  fetchBalances: () => Promise<void>;
}) {
  const [paymentMethod, setPaymentMethod] = useState('revolut');
  const [status, setStatus] = useState<string>('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { address: evmAddress } = useAccount();
  const { aztecCaipAccount, azguardClient } = useWalletStore();
  const flowStore = useFlowStore();

  // Execute deposit flow
  const handleDeposit = async () => {
    if (!azguardClient || !aztecCaipAccount || !evmAddress) {
      setError('Wallets not connected');
      return;
    }

    const amountBigInt = parseAmount(amount);
    if (amountBigInt <= 0n) {
      setError('Enter a valid amount');
      return;
    }

    setIsExecuting(true);
    setError(null);

    try {
      // Step 1: Initialize flow
      setStatus('Generating secret...');
      const flow = await initDepositFlow(amountBigInt);
      flowStore.startDepositFlow(flow);

      // Step 2: Check if we need to transfer from private to public
      if (aztecPrivateBalance >= amountBigInt && aztecPublicBalance < amountBigInt) {
        setStatus('Transferring tokens from private to public...');
        await transferToPublic(azguardClient, aztecCaipAccount, amountBigInt);
        await fetchBalances();
      }

      // Step 3: Set authwit for Train contract
      setStatus('Setting authorization (approve in Azguard)...');
      await setAuthwit(azguardClient, aztecCaipAccount, amountBigInt);

      // Step 4: Lock on Aztec
      setStatus('Locking tokens on Aztec...');
      const aztecTxHash = await lockOnAztec(
        azguardClient,
        aztecCaipAccount,
        SOLVER_AZTEC_ADDRESS,
        flow,
        evmAddress // Destination address on Base
      );
      flowStore.updateDepositFlow({ aztecLockTxHash: aztecTxHash, status: 'WAITING_SOLVER' });
      setStatus(`Locked on Aztec! TX: ${aztecTxHash.slice(0, 10)}...`);

      // Step 5: Wait for solver (in real scenario)
      setStatus('Waiting for solver to lock on Base... (demo: check manually)');

      // For demo purposes, we complete here
      setTimeout(() => {
        setStatus('Deposit flow initiated! Solver will bridge to zkp2p.');
        fetchBalances();
      }, 2000);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Deposit failed';
      setError(message);
      flowStore.failDepositFlow(message);
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* From Section (Aztec) */}
      <div className="bg-purple-900/20 rounded-xl p-4 border border-purple-800/30">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-gray-400">From (Aztec - Private)</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">
              {loadingBalances ? 'Loading...' : `Priv: ${formatTokenAmount(aztecPrivateBalance)} | Pub: ${formatTokenAmount(aztecPublicBalance)}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-2xl font-medium outline-none placeholder:text-gray-600"
          />
          <div className="flex items-center gap-2 px-3 py-2 bg-purple-900/50 rounded-lg">
            <div className="w-6 h-6 rounded-full bg-purple-500 flex items-center justify-center text-xs font-bold">$</div>
            <span className="font-medium text-purple-300">USDC</span>
          </div>
        </div>
      </div>

      {/* Arrow */}
      <div className="flex justify-center">
        <div className="w-10 h-10 rounded-full bg-gray-800 border-4 border-gray-900 flex items-center justify-center">
          <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </div>
      </div>

      {/* To Section (zkp2p) */}
      <div className="bg-green-900/20 rounded-xl p-4 border border-green-800/30">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-gray-400">To (zkp2p Deposit)</span>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={amount}
            readOnly
            placeholder="0.00"
            className="flex-1 bg-transparent text-2xl font-medium outline-none placeholder:text-gray-600 text-green-400"
          />
          <div className="flex items-center gap-2 px-3 py-2 bg-green-900/50 rounded-lg">
            <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center text-xs font-bold">$</div>
            <span className="font-medium text-green-300">USDC</span>
          </div>
        </div>
      </div>

      {/* Payment Method Selection */}
      <div className="space-y-2">
        <span className="text-sm text-gray-400">Accept payments via</span>
        <div className="grid grid-cols-3 gap-2">
          {['revolut', 'wise', 'venmo'].map((method) => (
            <button
              key={method}
              onClick={() => setPaymentMethod(method)}
              className={`py-2 px-3 rounded-lg text-sm font-medium capitalize transition-colors ${
                paymentMethod === method
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {method}
            </button>
          ))}
        </div>
      </div>

      {/* Status/Error */}
      {status && (
        <div className="text-sm text-blue-400 bg-blue-900/20 rounded-lg p-3">
          {status}
        </div>
      )}
      {error && (
        <div className="text-sm text-red-400 bg-red-900/20 rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Info */}
      <div className="text-xs text-gray-500 space-y-1">
        <div className="flex justify-between">
          <span>Route</span>
          <span>Aztec → Train → zkp2p</span>
        </div>
        <div className="flex justify-between">
          <span>Appears from</span>
          <span className="text-green-400">Fresh Address</span>
        </div>
      </div>

      {/* Action Button */}
      {!isAztecConnected ? (
        <button
          disabled
          className="w-full py-4 rounded-xl font-semibold bg-gray-700 text-gray-400 cursor-not-allowed"
        >
          Connect Aztec Wallet
        </button>
      ) : !amount || parseFloat(amount) <= 0 ? (
        <button
          disabled
          className="w-full py-4 rounded-xl font-semibold bg-gray-700 text-gray-400 cursor-not-allowed"
        >
          Enter Amount
        </button>
      ) : isExecuting ? (
        <button
          disabled
          className="w-full py-4 rounded-xl font-semibold bg-green-800 text-green-300 cursor-wait"
        >
          Processing...
        </button>
      ) : (
        <button
          onClick={handleDeposit}
          className="w-full py-4 rounded-xl font-semibold bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 transition-all"
        >
          Create zkp2p Deposit
        </button>
      )}
    </div>
  );
}
