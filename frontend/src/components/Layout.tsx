'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
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
import { TransactionHistory } from './TransactionHistory';
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
  const { disconnect: disconnectEvm } = useDisconnect();
  const publicClient = usePublicClient();

  const [mounted, setMounted] = useState(false);
  const [privateBalance, setPrivateBalance] = useState<bigint>(0n);
  const [publicBalance, setPublicBalance] = useState<bigint>(0n);
  const [baseBalance, setBaseBalance] = useState<bigint>(0n);
  const [isConnectingAztec, setIsConnectingAztec] = useState(false);
  const [isLoadingBalances, setIsLoadingBalances] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState<'aztec' | 'base' | null>(null);

  const copyToClipboard = async (address: string | undefined | null, type: 'aztec' | 'base') => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(type);
      setTimeout(() => setCopiedAddress(null), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

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

  const fetchBalances = useCallback(async (force: boolean = false) => {
    if (isAztecTxPending) {
      console.log('[Layout] Skipping balance fetch - Aztec tx pending');
      return;
    }
    setIsLoadingBalances(true);
    console.log('[Layout] Fetching balances...', force ? '(forced)' : '');

    const newBalances: { privateBalance?: string; publicBalance?: string; baseBalance?: string } = {};

    try {
      if (publicClient && evmAddress && TOKENS.base.address) {
        try {
          const bal = await getBaseUSDCBalance(publicClient, evmAddress);
          setBaseBalance(bal);
          newBalances.baseBalance = bal.toString();
        } catch (e) {
          console.error('Failed to fetch Base balance:', e);
        }
      }

      if (azguardClient && aztecCaipAccount && TOKENS.aztec.address) {
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
      const initialTimeout = setTimeout(() => {
        fetchBalances();
      }, 2000);

      return () => {
        clearTimeout(initialTimeout);
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

  const handleDisconnectAztec = async () => {
    try {
      const { disconnectAzguard } = await import('@/lib/aztec/azguardHelpers');
      const client = useWalletStore.getState().azguardClient;
      if (client) await disconnectAzguard(client);
    } catch (e) {}
    disconnectAztec();
  };

  const handleDisconnectAll = async () => {
    await handleDisconnectAztec();
    disconnectEvm();
  };

  // Prevent SSR
  if (!mounted) {
    return (
      <div className="min-h-screen bg-black text-gray-300 font-mono relative">
        <div className="starfield" />
        <div className="max-w-2xl mx-auto px-4 py-20 relative z-10">
          <div className="text-center">
            <h1 className="text-2xl text-white">zkzkp2p</h1>
            <p className="text-gray-500 text-sm mt-2">loading...</p>
          </div>
        </div>
      </div>
    );
  }

  const anyConnected = isAztecConnected || isEvmConnected;

  return (
    <div className="min-h-screen bg-black text-gray-300 font-mono relative">
      <div className="starfield" />
      {/* Header -- always visible */}
      <header className="border-b border-gray-900 px-4 py-3 relative z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-white">zkzkp2p</span>
            <span className="text-gray-800">|</span>
            {/* Aztec wallet */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">aztec:</span>
              {isAztecConnected ? (
                <>
                  <button
                    onClick={() => copyToClipboard(aztecAddress, 'aztec')}
                    className="text-sm hover:text-white cursor-pointer transition-colors"
                    title="Click to copy full address"
                  >
                    {copiedAddress === 'aztec' ? 'copied!' : shortenAddress(aztecAddress || '')}
                  </button>
                  <button
                    onClick={handleDisconnectAztec}
                    className="text-xs text-gray-700 hover:text-red-400 transition-colors"
                    title="Disconnect Aztec"
                  >
                    x
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectAztec}
                  disabled={isConnectingAztec}
                  className="text-xs border border-gray-700 px-2 py-1 hover:border-gray-500 hover:text-white transition-colors disabled:opacity-50"
                >
                  {isConnectingAztec ? '...' : 'connect'}
                </button>
              )}
            </div>
            <span className="text-gray-800">|</span>
            {/* Base wallet */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">base:</span>
              {isEvmConnected ? (
                <>
                  <button
                    onClick={() => copyToClipboard(evmAddress, 'base')}
                    className="text-sm hover:text-white cursor-pointer transition-colors"
                    title="Click to copy full address"
                  >
                    {copiedAddress === 'base' ? 'copied!' : shortenAddress(evmAddress || '')}
                  </button>
                  <button
                    onClick={() => disconnectEvm()}
                    className="text-xs text-gray-700 hover:text-red-400 transition-colors"
                    title="Disconnect Base"
                  >
                    x
                  </button>
                </>
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
          <div className="flex items-center gap-4">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-600 hover:text-gray-400"
            >
              docs
            </a>
            {isAztecConnected && (
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
            )}
            {anyConnected && (
              <button
                onClick={handleDisconnectAll}
                className="text-xs text-gray-600 hover:text-red-400"
              >
                disconnect all
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8 relative z-10">
        {!anyConnected ? (
          /* Landing -- no wallets connected */
          <div className="max-w-md mx-auto py-12">
            <div className="text-center space-y-6">
              <p className="text-gray-500 text-sm">private liquidity for peer-to-peer payments</p>
              <p className="text-xs text-gray-600">
                connect your wallets above to get started
              </p>
              <p className="text-xs text-gray-700">
                requires{' '}
                <a href="https://azguardwallet.io" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-400">
                  azguard wallet
                </a>
                {' + '}
                <a href="https://metamask.io" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-400">
                  metamask
                </a>
              </p>
            </div>
          </div>
        ) : (
          /* App -- at least one wallet connected */
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <CreateDeposit
                privateBalance={privateBalance}
                onRefreshBalances={fetchBalances}
              />
              <PrivateAccount
                privateBalance={privateBalance}
                publicBalance={publicBalance}
                baseBalance={baseBalance}
                isEvmConnected={isEvmConnected}
                onTopUp={fetchBalances}
              />
            </div>
            <TransactionHistory />
          </>
        )}
      </main>
    </div>
  );
}
