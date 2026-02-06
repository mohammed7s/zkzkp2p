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

const DOCS_URL = '/docs';
const GITHUB_URL = 'https://github.com/mohammed7s/zkzkp2p';
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
            <a href="/" className="text-white hover:opacity-80">zkzkp2p</a>
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
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-600 hover:text-gray-400"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
              </svg>
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
            {!anyConnected && (
              <ConnectButton.Custom>
                {({ openConnectModal }) => (
                  <button
                    onClick={async () => {
                      await handleConnectAztec();
                      openConnectModal();
                    }}
                    disabled={isConnectingAztec}
                    className="px-4 py-1.5 bg-white text-black text-sm rounded-full hover:bg-gray-200 disabled:opacity-50 transition-colors"
                  >
                    {isConnectingAztec ? 'connecting...' : 'login'}
                  </button>
                )}
              </ConnectButton.Custom>
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
          <div className="flex-1 flex flex-col items-center justify-center py-24 px-4">
            <div className="max-w-md text-center space-y-6">
              <img
                src="/logos/wordmark.svg"
                alt="zkzkp2p"
                className="h-10 w-auto mx-auto"
              />
              <p className="text-gray-400">
                the privacy layer for{' '}
                <a
                  href="https://zkp2p.xyz"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white hover:underline"
                >
                  zkp2p
                </a>
              </p>
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
            <footer className="mt-auto pt-12 pb-6">
              <p className="text-center text-xs text-gray-700 font-mono">
                built on{' '}
                <a href="https://aztec.network" target="_blank" rel="noopener noreferrer" className="hover:text-gray-500">aztec</a>
                {' + '}
                <a href="https://substance.exchange" target="_blank" rel="noopener noreferrer" className="hover:text-gray-500">substance</a>
                {' + '}
                <a href="https://zkp2p.xyz" target="_blank" rel="noopener noreferrer" className="hover:text-gray-500">zkp2p</a>
              </p>
            </footer>
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
