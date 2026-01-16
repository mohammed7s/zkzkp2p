'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useWalletStore } from '@/stores/walletStore';
import {
  getBaseUSDCBalance,
  getAztecPrivateBalance,
  getAztecPublicBalance,
  formatTokenAmount,
  TOKENS,
} from '@/lib/bridge';
import { usePublicClient } from 'wagmi';
import { CreateDeposit } from './CreateDeposit';
import { PrivateAccount } from './PrivateAccount';

const DOCS_URL = 'https://docs.aztec.network';
const BALANCE_CACHE_PREFIX = 'zkzkp2p-balance-cache';

function getBalanceCacheKey(aztecAccount?: string | null, evmAddress?: string | null): string | null {
  if (!aztecAccount && !evmAddress) return null;
  const aztecKey = aztecAccount ? aztecAccount.toLowerCase() : 'none';
  const evmKey = evmAddress ? evmAddress.toLowerCase() : 'none';
  return `${BALANCE_CACHE_PREFIX}:${aztecKey}:${evmKey}`;
}

function shortenAddress(address: string, chars = 4): string {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function Layout() {
  // All hooks must be called before any early returns
  const { isConnected: isEvmConnected, address: evmAddress } = useAccount();
  const {
    isAztecConnected,
    aztecAddress,
    aztecCaipAccount,
    azguardClient,
    isAztecTxPending,
    disconnectAztec,
    setAztecConnected,
    setAztecError
  } = useWalletStore();
  const publicClient = usePublicClient();

  const [mounted, setMounted] = useState(false);
  const [privateBalance, setPrivateBalance] = useState<bigint>(0n);
  const [publicBalance, setPublicBalance] = useState<bigint>(0n);
  const [baseBalance, setBaseBalance] = useState<bigint>(0n);
  const [isConnectingAztec, setIsConnectingAztec] = useState(false);
  const [isLoadingBalances, setIsLoadingBalances] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const cacheKey = getBalanceCacheKey(aztecCaipAccount, evmAddress);
    if (!cacheKey) {
      setPrivateBalance(0n);
      setPublicBalance(0n);
      setBaseBalance(0n);
      return;
    }

    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const { privateBalance: priv, publicBalance: pub, baseBalance: base } = JSON.parse(cached);
        if (priv) setPrivateBalance(BigInt(priv));
        if (pub) setPublicBalance(BigInt(pub));
        if (base) setBaseBalance(BigInt(base));
        console.log('[Layout] Loaded cached balances');
      } else {
        setPrivateBalance(0n);
        setPublicBalance(0n);
        setBaseBalance(0n);
      }
    } catch (e) {
      console.error('[Layout] Failed to load cached balances:', e);
    }
  }, [mounted, aztecCaipAccount, evmAddress]);

  // Fetch balances SEQUENTIALLY to prevent Azguard IDB conflicts
  // Skip if a tx is pending - Azguard has IDB issues with concurrent operations
  // Use force=true for post-transaction refresh (still respects tx pending check)
  const fetchBalances = useCallback(async (force: boolean = false) => {
    // Always respect isAztecTxPending - concurrent IDB operations cause Brillig errors
    if (isAztecTxPending) {
      console.log('[Layout] Skipping balance fetch - Aztec tx pending');
      return;
    }
    setIsLoadingBalances(true);
    console.log('[Layout] Fetching balances...', force ? '(forced)' : '');

    const newBalances: { privateBalance?: string; publicBalance?: string; baseBalance?: string } = {};

    try {
      // Base balance (fast - direct RPC, can run independently)
      if (publicClient && evmAddress && TOKENS.base.address) {
        try {
          const bal = await getBaseUSDCBalance(publicClient, evmAddress);
          setBaseBalance(bal);
          newBalances.baseBalance = bal.toString();
        } catch (e) {
          console.error('Failed to fetch Base balance:', e);
        }
      }

      // Aztec balances - use SEPARATE calls (original working approach)
      if (azguardClient && aztecCaipAccount && TOKENS.aztec.address) {
        // First: private balance
        try {
          console.log('[Layout] Fetching private balance...');
          const priv = await getAztecPrivateBalance(azguardClient, aztecCaipAccount);
          if (priv !== null) {
            setPrivateBalance(priv);
            newBalances.privateBalance = priv.toString();
            console.log('[Layout] Private balance:', priv.toString());
          } else {
            console.log('[Layout] Private balance query returned null, keeping previous value');
          }
        } catch (e) {
          console.error('[Layout] Failed to fetch private balance:', e);
        }

        // Second: public balance (separate call)
        try {
          console.log('[Layout] Fetching public balance...');
          const pub = await getAztecPublicBalance(azguardClient, aztecCaipAccount);
          if (pub !== null) {
            setPublicBalance(pub);
            newBalances.publicBalance = pub.toString();
            console.log('[Layout] Public balance:', pub.toString());
          } else {
            console.log('[Layout] Public balance query returned null, keeping previous value');
          }
        } catch (e) {
          console.error('[Layout] Failed to fetch public balance:', e);
        }
      }

      // Cache the balances for next page load
      if (Object.keys(newBalances).length > 0) {
        try {
          const cacheKey = getBalanceCacheKey(aztecCaipAccount, evmAddress);
          if (!cacheKey) return;

          const existing = localStorage.getItem(cacheKey);
          const cached = existing ? JSON.parse(existing) : {};
          localStorage.setItem(cacheKey, JSON.stringify({ ...cached, ...newBalances }));
        } catch (e) {
          console.error('[Layout] Failed to cache balances:', e);
        }
      }
    } finally {
      setIsLoadingBalances(false);
    }
  }, [publicClient, evmAddress, azguardClient, aztecCaipAccount, isAztecTxPending]);

  useEffect(() => {
    if (mounted && isAztecConnected && !isAztecTxPending) {
      // Delay initial fetch by 1s to ensure React state is fully settled
      // This prevents racing with the post-connection IDB stabilization
      const initialTimeout = setTimeout(() => {
        fetchBalances();
      }, 1000);

      // Polling every 30s - no longer bypasses isAztecTxPending since we
      // now always check it (Brillig errors were caused by IDB conflicts)
      const interval = setInterval(() => fetchBalances(), 30000);

      return () => {
        clearTimeout(initialTimeout);
        clearInterval(interval);
      };
    }
  }, [fetchBalances, mounted, isAztecConnected, isAztecTxPending]);

  const handleConnectAztec = async () => {
    if (isConnectingAztec) return;
    setIsConnectingAztec(true);
    setAztecError(null);

    try {
      const { connectAzguard } = await import('@/lib/aztec/azguardHelpers');
      const result = await connectAzguard();
      if (result) {
        // Wait for Azguard's IDB to stabilize before setting connected state
        // This ensures balance fetch doesn't race with Azguard initialization
        // Increased delay from 2s to 3s to prevent IDB conflicts on first fetch
        console.log('[Layout] Connected to Azguard, waiting for IDB to stabilize...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        setAztecConnected(result.address, result.caipAccount, result.client);
        console.log('[Layout] Azguard ready, will fetch balances now');
      }
    } catch (error: any) {
      setAztecError(error.message || 'Failed to connect');
    } finally {
      setIsConnectingAztec(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      const { disconnectAzguard } = await import('@/lib/aztec/azguardHelpers');
      const client = useWalletStore.getState().azguardClient;
      if (client) await disconnectAzguard(client);
    } catch (e) {}
    disconnectAztec();
  };

  // Prevent SSR - render loading state on server
  if (!mounted) {
    return (
      <div className="min-h-screen bg-black text-gray-300 font-mono">
        <div className="max-w-2xl mx-auto px-4 py-20">
          <div className="text-center">
            <h1 className="text-2xl text-white">zkzkp2p</h1>
            <p className="text-gray-500 text-sm mt-2">loading...</p>
          </div>
        </div>
      </div>
    );
  }

  // Not connected state
  if (!isAztecConnected) {
    return (
      <div className="min-h-screen bg-black text-gray-300 font-mono">
        {/* Header with docs link */}
        <header className="border-b border-gray-900 px-4 py-3">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <span className="text-white">zkzkp2p</span>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-600 hover:text-gray-400"
            >
              docs
            </a>
          </div>
        </header>

        <div className="max-w-2xl mx-auto px-4 py-20">
          <div className="text-center space-y-8">
            <div className="space-y-2">
              <p className="text-gray-500 text-sm">private liquidity for peer-to-peer payments</p>
            </div>

            <div className="border border-gray-800 p-8 space-y-6">
              <p className="text-sm text-gray-400">
                Connect your private wallet to create deposits and receive payments.
              </p>

              <button
                onClick={handleConnectAztec}
                disabled={isConnectingAztec}
                className="w-full py-3 border border-gray-600 hover:border-gray-400 hover:text-white transition-colors disabled:opacity-50"
              >
                {isConnectingAztec ? 'connecting...' : 'connect aztec wallet'}
              </button>

              <p className="text-xs text-gray-600">
                requires <a href="https://azguard.xyz" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-400">azguard wallet</a>
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Connected state
  return (
    <div className="min-h-screen bg-black text-gray-300 font-mono">
      {/* Header */}
      <header className="border-b border-gray-900 px-4 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-6">
            <span className="text-white">zkzkp2p</span>
            <span className="text-gray-600 text-sm">|</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">aztec:</span>
              <span className="text-sm">{shortenAddress(aztecAddress || '')}</span>
            </div>
            <span className="text-gray-800">|</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">base:</span>
              {isEvmConnected ? (
                <span className="text-sm">{shortenAddress(evmAddress || '')}</span>
              ) : (
                <ConnectButton.Custom>
                  {({ openConnectModal }) => (
                    <button
                      onClick={openConnectModal}
                      className="text-xs border border-gray-700 px-2 py-1 hover:border-gray-500 hover:text-white transition-colors"
                    >
                      connect
                    </button>
                  )}
                </ConnectButton.Custom>
              )}
            </div>
          </div>
          <div className="flex items-center gap-6">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-600 hover:text-gray-400"
            >
              docs
            </a>
            <span className="text-sm flex items-center gap-2">
              <span className="text-gray-500">private:</span>{' '}
              <span className="text-white">{formatTokenAmount(privateBalance)} USDC</span>
              <button
                onClick={() => fetchBalances(true)}
                disabled={isLoadingBalances}
                className="ml-1 px-2 py-0.5 text-xs border border-gray-700 hover:border-gray-500 hover:text-white disabled:opacity-50 transition-colors"
                title="Refresh balances"
              >
                {isLoadingBalances ? 'loading...' : 'refresh'}
              </button>
            </span>
            <button
              onClick={handleDisconnect}
              className="text-xs text-gray-600 hover:text-gray-400"
            >
              disconnect
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left: Create Deposit */}
          <CreateDeposit
            privateBalance={privateBalance}
            onRefreshBalances={fetchBalances}
          />

          {/* Right: Private Account */}
          <PrivateAccount
            privateBalance={privateBalance}
            publicBalance={publicBalance}
            baseBalance={baseBalance}
            isEvmConnected={isEvmConnected}
            onTopUp={fetchBalances}
          />
        </div>
      </main>
    </div>
  );
}
