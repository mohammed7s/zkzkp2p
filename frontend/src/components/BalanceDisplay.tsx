'use client';

import { useAccount, useBalance } from 'wagmi';
import { useWalletStore } from '@/stores/walletStore';
import { useState, useEffect } from 'react';

// USDC on Base Sepolia
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

function formatBalance(value: bigint | undefined, decimals: number = 6): string {
  if (!value) return '0.00';
  const divisor = BigInt(10 ** decimals);
  const intPart = value / divisor;
  const fracPart = value % divisor;
  const fracStr = fracPart.toString().padStart(decimals, '0').slice(0, 2);
  return `${intPart}.${fracStr}`;
}

export function BalanceDisplay() {
  const { address: evmAddress, isConnected: isEvmConnected } = useAccount();
  const { aztecAddress, isAztecConnected, azguardClient } = useWalletStore();

  const [aztecBalance, setAztecBalance] = useState<bigint | null>(null);
  const [isLoadingAztec, setIsLoadingAztec] = useState(false);

  // EVM USDC balance
  const { data: usdcBalance, isLoading: isLoadingUsdc } = useBalance({
    address: evmAddress,
    token: USDC_ADDRESS,
  });

  // ETH balance for gas
  const { data: ethBalance } = useBalance({
    address: evmAddress,
  });

  // Fetch Aztec balance when connected
  useEffect(() => {
    async function fetchAztecBalance() {
      if (!isAztecConnected || !azguardClient || !aztecAddress) {
        setAztecBalance(null);
        return;
      }

      setIsLoadingAztec(true);
      try {
        // TODO: Implement actual Aztec token balance query via Azguard
        // For now, show placeholder
        // const { simulateAzguardView } = await import('@/lib/aztec/azguardHelpers');
        // const balance = await simulateAzguardView(
        //   azguardClient,
        //   aztecAddress,
        //   tokenContractAddress,
        //   'balance_of_private',
        //   [aztecAddress]
        // );
        // setAztecBalance(balance);
        setAztecBalance(null); // Placeholder until Azguard connection works
      } catch (error) {
        console.error('Failed to fetch Aztec balance:', error);
        setAztecBalance(null);
      } finally {
        setIsLoadingAztec(false);
      }
    }

    fetchAztecBalance();
  }, [isAztecConnected, azguardClient, aztecAddress]);

  if (!isEvmConnected && !isAztecConnected) {
    return null;
  }

  return (
    <div className="p-4 border rounded-lg bg-gray-900">
      <h3 className="text-sm font-medium text-gray-400 mb-3">Balances</h3>

      {/* Base (L1) Balances */}
      {isEvmConnected && (
        <div className="mb-4">
          <div className="text-xs text-gray-500 mb-2">Base (L1)</div>
          <div className="space-y-2">
            {/* USDC */}
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center text-xs font-bold">
                  $
                </span>
                <span className="text-sm">USDC</span>
              </div>
              <div className="text-right">
                {isLoadingUsdc ? (
                  <span className="text-gray-500 text-sm">Loading...</span>
                ) : (
                  <span className="text-sm font-mono">
                    {formatBalance(usdcBalance?.value, 6)}
                  </span>
                )}
              </div>
            </div>

            {/* ETH for gas */}
            <div className="flex justify-between items-center text-gray-500 text-xs">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 bg-gray-700 rounded-full flex items-center justify-center text-[10px]">
                  E
                </span>
                <span>ETH (gas)</span>
              </div>
              <span className="font-mono">
                {ethBalance ? formatBalance(ethBalance.value, 18) : '0.00'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Aztec (L2) Balances */}
      {isAztecConnected && (
        <div>
          <div className="text-xs text-gray-500 mb-2">Aztec (L2) - Private</div>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 bg-purple-600 rounded-full flex items-center justify-center text-xs font-bold">
                  $
                </span>
                <span className="text-sm">USDC</span>
                <span className="text-[10px] px-1 py-0.5 bg-purple-900 text-purple-300 rounded">
                  shielded
                </span>
              </div>
              <div className="text-right">
                {isLoadingAztec ? (
                  <span className="text-gray-500 text-sm">Loading...</span>
                ) : aztecBalance !== null ? (
                  <span className="text-sm font-mono">
                    {formatBalance(aztecBalance, 6)}
                  </span>
                ) : (
                  <span className="text-gray-500 text-sm">--</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Connection prompts */}
      {!isEvmConnected && isAztecConnected && (
        <p className="text-xs text-gray-500 mt-2">
          Connect Base wallet to see L1 balance
        </p>
      )}
      {isEvmConnected && !isAztecConnected && (
        <p className="text-xs text-gray-500 mt-2">
          Connect Aztec wallet to see shielded balance
        </p>
      )}
    </div>
  );
}
