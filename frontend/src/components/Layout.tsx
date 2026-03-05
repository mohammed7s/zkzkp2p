'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useAccount, useDisconnect, useWalletClient } from 'wagmi';
import { usePrivy, useWallets, useCreateWallet } from '@privy-io/react-auth';
import { useWalletStore } from '@/stores/walletStore';
import {
  getBaseUSDCBalance,
  getAztecPrivateBalance,
  getAztecPublicBalance,
} from '@/lib/bridge/balances';
import { formatTokenAmount } from '@/lib/bridge/format';
import { TOKENS } from '@/lib/bridge/config';
import { usePublicClient } from 'wagmi';
import type { Hex } from 'viem';

const DOCS_URL = '/docs';
const GITHUB_URL = 'https://github.com/mohammed7s/zkzkp2p';
const BALANCE_CACHE_PREFIX = 'zkzkp2p-balance-cache';
const CreateDeposit = dynamic(() => import('./CreateDeposit').then((m) => m.CreateDeposit), { ssr: false });
const PrivateAccount = dynamic(() => import('./PrivateAccount').then((m) => m.PrivateAccount), { ssr: false });
const TransactionHistory = dynamic(() => import('./TransactionHistory').then((m) => m.TransactionHistory), { ssr: false });

function getBalanceCacheKey(aztecAddress?: string | null, evmAddress?: string | null): string | null {
  if (!aztecAddress && !evmAddress) return null;
  const aztecKey = aztecAddress ? aztecAddress.toLowerCase() : 'none';
  const evmKey = evmAddress ? evmAddress.toLowerCase() : 'none';
  return `${BALANCE_CACHE_PREFIX}:${aztecKey}:${evmKey}`;
}

function shortenAddress(address: string, chars = 4): string {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function Layout() {
  const { isConnected: isEvmConnected, address: evmAddress } = useAccount();
  const {
    isAztecConnected,
    aztecAddress,
    aztecWallet,
    aztecError,
    isAztecTxPending,
    disconnectAztec,
    setAztecConnected,
    setAztecError
  } = useWalletStore();
  const { login, logout, ready: privyReady, authenticated, user } = usePrivy();
  const { wallets: privyWallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { disconnect: disconnectEvm } = useDisconnect();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [mounted, setMounted] = useState(false);

  // Debug: log Privy + wagmi state
  useEffect(() => {
    if (!mounted) return;
    console.log('[Layout] State:', {
      privyReady,
      authenticated,
      privyUser: user?.id,
      privyWallets: privyWallets.map(w => ({ address: w.address, type: w.walletClientType, chain: w.chainId })),
      wagmiConnected: isEvmConnected,
      wagmiAddress: evmAddress,
      walletClientReady: !!walletClient,
    });
  }, [mounted, privyReady, authenticated, user, privyWallets, isEvmConnected, evmAddress, walletClient]);

  // Fallback: if authenticated but no embedded wallet exists, create one explicitly
  const creatingWalletRef = useRef(false);
  useEffect(() => {
    if (!mounted || !privyReady || !authenticated || creatingWalletRef.current) return;
    const hasEmbeddedWallet = privyWallets.some(w => w.walletClientType === 'privy');
    if (!hasEmbeddedWallet && privyWallets.length === 0) {
      creatingWalletRef.current = true;
      console.log('[Layout] No embedded wallet found, creating...');
      createWallet()
        .then((wallet) => {
          console.log('[Layout] Embedded wallet created:', wallet.address);
        })
        .catch((err) => {
          // May fail if wallet already exists or is being created — that's fine
          console.warn('[Layout] createWallet fallback:', err.message || err);
        })
        .finally(() => {
          creatingWalletRef.current = false;
        });
    }
  }, [mounted, privyReady, authenticated, privyWallets, createWallet]);

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

  const [isAutoReconnecting, setIsAutoReconnecting] = useState(false);
  const connectingRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Auto-connect Aztec when EVM wallet connects (MetaMask or Privy embedded):
  // - If cached keys exist in sessionStorage → reconnect silently (no popup)
  // - If no cached keys → derive via wallet signature (first time)
  // For signing, use walletClient (MetaMask) or Privy wallet provider (embedded).
  // useWalletClient() often returns null for Privy embedded wallets, so we fall back
  // to privyWallets[].getEthereumProvider() which supports personal_sign directly.
  useEffect(() => {
    if (!mounted || !isEvmConnected || !evmAddress || isAztecConnected) return;
    if (connectingRef.current) return;

    // Check for cached keys synchronously
    const SESSION_KEY = 'zkzkp2p-aztec-keys';
    let hasCached = false;
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        hasCached = data.address === evmAddress.toLowerCase();
      }
    } catch {}

    // Find a Privy embedded wallet as fallback signer
    const privyWallet = privyWallets.find(w => w.address?.toLowerCase() === evmAddress.toLowerCase());

    // If no cached keys, we need either walletClient or a Privy wallet to sign
    if (!hasCached && !walletClient && !privyWallet) return;

    connectingRef.current = true;

    (async () => {
      const { hasCachedKeys, reconnectEmbeddedWallet, connectEmbeddedWallet } = await import('@/lib/aztec/embeddedWallet');

      if (hasCachedKeys(evmAddress)) {
        // Reconnect from cached keys — no signature popup
        console.log('[Layout] Auto-reconnecting Aztec wallet from cached keys...');
        setIsAutoReconnecting(true);
        try {
          const result = await reconnectEmbeddedWallet(evmAddress);
          if (result) {
            console.log('[Layout] Auto-reconnected, address:', result.address);
            setAztecConnected(result.address, result.wallet);
          }
        } catch (error: any) {
          console.error('[Layout] Auto-reconnect failed:', error);
        } finally {
          setIsAutoReconnecting(false);
          connectingRef.current = false;
        }
      } else {
        // First time — derive via wallet signature
        console.log('[Layout] First connection — deriving Aztec wallet...');
        setIsConnectingAztec(true);
        setAztecError(null);
        try {
          let signMessage: (message: string) => Promise<Hex>;

          if (walletClient) {
            // MetaMask / injected wallet path
            signMessage = async (message: string): Promise<Hex> => {
              return await walletClient.signMessage({ account: evmAddress, message }) as Hex;
            };
          } else if (privyWallet) {
            // Privy embedded wallet path — use EIP-1193 provider directly
            const provider = await privyWallet.getEthereumProvider();
            signMessage = async (message: string): Promise<Hex> => {
              return await provider.request({
                method: 'personal_sign',
                params: [message, evmAddress],
              }) as Hex;
            };
          } else {
            throw new Error('No signer available');
          }

          const result = await connectEmbeddedWallet(signMessage, evmAddress);
          console.log('[Layout] Derived Aztec wallet, address:', result.address);
          setAztecConnected(result.address, result.wallet);
        } catch (error: any) {
          console.error('[Layout] Aztec derivation failed:', error);
          setAztecError(error.message || 'Failed to derive');
        } finally {
          setIsConnectingAztec(false);
          connectingRef.current = false;
        }
      }
    })();
  }, [mounted, isEvmConnected, evmAddress, walletClient, privyWallets, isAztecConnected, setAztecConnected, setAztecError]);

  useEffect(() => {
    if (!mounted) return;

    const cacheKey = getBalanceCacheKey(aztecAddress, evmAddress);
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
  }, [mounted, aztecAddress, evmAddress]);

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

      if (aztecWallet && aztecAddress && TOKENS.aztec.address) {
        try {
          console.log('[Layout] Fetching private balance...');
          const priv = await getAztecPrivateBalance(aztecWallet, aztecAddress);
          if (priv !== null) {
            setPrivateBalance(priv);
            newBalances.privateBalance = priv.toString();
            console.log('[Layout] Private balance:', priv.toString());
          }
        } catch (e) {
          console.error('[Layout] Failed to fetch private balance:', e);
        }

        try {
          console.log('[Layout] Fetching public balance...');
          const pub = await getAztecPublicBalance(aztecWallet, aztecAddress);
          if (pub !== null) {
            setPublicBalance(pub);
            newBalances.publicBalance = pub.toString();
            console.log('[Layout] Public balance:', pub.toString());
          }
        } catch (e) {
          console.error('[Layout] Failed to fetch public balance:', e);
        }
      }

      if (Object.keys(newBalances).length > 0) {
        try {
          const cacheKey = getBalanceCacheKey(aztecAddress, evmAddress);
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
  }, [publicClient, evmAddress, aztecWallet, aztecAddress, isAztecTxPending]);

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

  const handleDisconnect = async () => {
    try {
      const { disconnectEmbeddedWallet } = await import('@/lib/aztec/embeddedWallet');
      await disconnectEmbeddedWallet();
    } catch (e) {}
    disconnectAztec();
    disconnectEvm();
    try { await logout(); } catch (e) {}
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

  return (
    <div className="min-h-screen bg-black text-gray-300 font-mono relative">
      <div className="starfield" />
      {/* Header */}
      <header className="border-b border-gray-900 px-4 py-3 relative z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="text-white hover:opacity-80">zkzkp2p</a>
            {(authenticated || isEvmConnected) && (
              <>
                <span className="text-gray-800">|</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-600">base:</span>
                  <button
                    onClick={() => copyToClipboard(evmAddress, 'base')}
                    className="text-sm hover:text-white cursor-pointer transition-colors"
                    title="Click to copy full address"
                  >
                    {copiedAddress === 'base' ? 'copied!' : shortenAddress(evmAddress || '')}
                  </button>
                </div>
                <span className="text-gray-800">|</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-600">aztec:</span>
                  {isAztecConnected ? (
                    <button
                      onClick={() => copyToClipboard(aztecAddress, 'aztec')}
                      className="text-sm hover:text-white cursor-pointer transition-colors"
                      title="Click to copy full address"
                    >
                      {copiedAddress === 'aztec' ? 'copied!' : shortenAddress(aztecAddress || '')}
                    </button>
                  ) : (isConnectingAztec || isAutoReconnecting) ? (
                    <span className="text-xs text-gray-500 animate-pulse">setting up...</span>
                  ) : aztecError ? (
                    <span className="text-xs text-red-400 truncate max-w-[200px]" title={aztecError}>{aztecError}</span>
                  ) : (
                    <span className="text-xs text-gray-600">--</span>
                  )}
                </div>
              </>
            )}
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
            {!authenticated && !isEvmConnected && (
              <button
                onClick={login}
                className="px-4 py-1.5 bg-white text-black text-sm rounded-full hover:bg-gray-200 disabled:opacity-50 transition-colors"
              >
                login
              </button>
            )}
            {(authenticated || isEvmConnected) && (
              <button
                onClick={handleDisconnect}
                className="text-xs text-gray-500 hover:text-red-400 border border-gray-700 hover:border-red-400 px-1.5 py-0.5 rounded transition-colors"
              >
                disconnect
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8 relative z-10">
        {!authenticated && !isEvmConnected ? (
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
                connect your wallet to get started
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
          <>
            {!isAztecConnected ? (
              <div className="border border-gray-900 bg-gray-950/50 p-8 text-center">
                {(isConnectingAztec || isAutoReconnecting) ? (
                  <p className="text-sm text-gray-400 animate-pulse">setting up aztec wallet...</p>
                ) : aztecError ? (
                  <div className="space-y-2">
                    <p className="text-sm text-red-400">aztec wallet setup failed</p>
                    <p className="text-xs text-gray-600">{aztecError}</p>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">waiting for aztec wallet setup...</p>
                )}
              </div>
            ) : (
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
          </>
        )}
      </main>
    </div>
  );
}
