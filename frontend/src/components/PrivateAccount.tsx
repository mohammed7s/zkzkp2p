import { useState } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { useWalletStore } from '@/stores/walletStore';
import { BASE_EXPLORER_URL } from '@/config';
import {
  formatTokenAmount,
  parseTokenAmount,
  TOKENS,
} from '@/lib/bridge';
import {
  executeBaseToAztecBridge,
  isBaseToAztecBridgeConfigured,
} from '@/lib/nearIntents';
import type { Hex } from 'viem';

interface PrivateAccountProps {
  privateBalance: bigint;
  publicBalance: bigint;
  baseBalance: bigint;
  burnerBalance: bigint;
  isEvmConnected: boolean;
  onTopUp: () => void;
}

export function PrivateAccount({
  baseBalance,
  isEvmConnected,
  onTopUp,
}: PrivateAccountProps) {
  const [showFund, setShowFund] = useState(false);
  const [amount, setAmount] = useState('');
  const [isFunding, setIsFunding] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const { address: evmAddress } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { aztecAddress, aztecWallet } = useWalletStore();

  const bridgeConfigured = isBaseToAztecBridgeConfigured();
  const amountBigInt = amount ? parseTokenAmount(amount) : 0n;
  const hasEnoughBase = baseBalance >= amountBigInt;

  const handleFund = async () => {
    if (!walletClient || !publicClient || !aztecWallet || !aztecAddress || !evmAddress) return;
    if (amountBigInt <= 0n) return;

    setIsFunding(true);
    setError(null);
    setStatus('sending to solver...');
    setTxHash(null);

    try {
      await executeBaseToAztecBridge({
        walletClient,
        publicClient,
        evmSender: evmAddress as Hex,
        aztecRecipient: aztecAddress,
        amount: amountBigInt,
        callbacks: {
          onSendingToSolver: () => setStatus('sending Base USDC to solver...'),
          onBaseTxConfirmed: (hash) => {
            setTxHash(hash);
            setStatus('base tx confirmed. generating zero-knowledge proof (1-2 min)...');
          },
          onWaitingForFill: () => setStatus('generating zero-knowledge proof — your private transfer is being encrypted...'),
          onAztecTxConfirmed: () => setStatus('private transfer confirmed!'),
        },
      });

      setStatus(`${formatTokenAmount(amountBigInt)} USDC added to private balance`);
      setAmount('');
      setTimeout(() => {
        onTopUp();
        setShowFund(false);
        setStatus(null);
        setTxHash(null);
      }, 3000);
    } catch (e: any) {
      setError(e.message || 'funding failed');
      setStatus(null);
    } finally {
      setIsFunding(false);
    }
  };

  if (!showFund) {
    return (
      <button
        onClick={() => setShowFund(true)}
        disabled={!isEvmConnected || !bridgeConfigured}
        className="w-full py-3 text-sm border border-gray-700 hover:border-gray-500 hover:text-white disabled:opacity-30 transition-colors"
      >
        fund wallet
      </button>
    );
  }

  return (
    <div className="border border-gray-800 p-4 space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-xs text-gray-500 uppercase">fund from base</span>
        <button
          onClick={() => { setShowFund(false); setError(null); setStatus(null); }}
          className="text-xs text-gray-600 hover:text-gray-400"
        >cancel</button>
      </div>

      <div className="text-xs text-gray-600">
        Send USDC from your Base wallet to your private balance.
        {baseBalance > 0n && (
          <span className="text-gray-400 ml-1">({formatTokenAmount(baseBalance)} USDC available)</span>
        )}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="flex-1 bg-transparent border border-gray-700 px-3 py-1.5 text-sm text-white focus:border-gray-500 outline-none"
        />
        <button
          onClick={() => setAmount(formatTokenAmount(baseBalance))}
          className="text-xs text-gray-600 hover:text-gray-400 px-2 border border-gray-800 hover:border-gray-600"
        >max</button>
      </div>

      {!hasEnoughBase && amountBigInt > 0n && (
        <div className="text-xs text-red-500">
          insufficient balance (have {formatTokenAmount(baseBalance)})
        </div>
      )}

      {!isFunding ? (
        <button
          onClick={handleFund}
          disabled={!hasEnoughBase || amountBigInt <= 0n}
          className="w-full py-2 text-sm bg-white text-black hover:bg-gray-200 disabled:opacity-30 transition-colors"
        >
          fund {amount || '0'} USDC
        </button>
      ) : (
        <div className="border border-gray-700 bg-gray-900/50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-gray-500 border-t-white rounded-full animate-spin" />
            <span className="text-sm text-gray-300">{status || 'funding...'}</span>
          </div>
          {status?.includes('proof') && (
            <div className="w-full bg-gray-800 h-1 overflow-hidden">
              <div className="h-full bg-gray-600 animate-pulse" style={{ width: '60%' }} />
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-500 break-all">{error}</div>
      )}

      {txHash && (
        <div className="text-xs text-gray-600">
          tx: <a
            href={`${BASE_EXPLORER_URL}/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:text-blue-300 underline"
          >{txHash.slice(0, 10)}...{txHash.slice(-6)}</a>
        </div>
      )}

      {!isFunding && status && !error && (
        <div className="text-xs text-green-400">{status}</div>
      )}
    </div>
  );
}
