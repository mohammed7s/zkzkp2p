

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount, useDisconnect, useWalletClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useWalletStore } from '@/stores/walletStore';
import {
  getBaseUSDCBalance,
  getAztecPrivateBalance,
  getAztecPublicBalance,
  formatTokenAmount,
  TOKENS,
} from '@/lib/bridge';
import { TIMING, BASE_EXPLORER_URL } from '@/config';
import { usePublicClient } from 'wagmi';
import { CreateDeposit } from './CreateDeposit';
import { TransactionHistory } from './TransactionHistory';
import { PrivateAccount } from './PrivateAccount';
import { MyDeposits } from './MyDeposits';
import { scanAndRecover, type FundedBurner } from '@/lib/burner';
import { getSmartAccountAddress } from '@/lib/paymaster';
import type { Hex } from 'viem';

const DOCS_URL = '/docs';
const GITHUB_URL = 'https://github.com/mohammed7s/zkzkp2p';
const BALANCE_CACHE_PREFIX = 'zkzkp2p-balance-cache';

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
    isAztecDeployed,
    isDeployingAztec,
    disconnectAztec,
    setAztecConnected,
    setAztecError
  } = useWalletStore();
  const { disconnect: disconnectEvm } = useDisconnect();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [mounted, setMounted] = useState(false);
  const [privateBalance, setPrivateBalance] = useState<bigint>(0n);
  const [publicBalance, setPublicBalance] = useState<bigint>(0n);
  const [baseBalance, setBaseBalance] = useState<bigint>(0n);
  const [burnerBalance, setBurnerBalance] = useState<bigint>(0n);
  const [isConnectingAztec, setIsConnectingAztec] = useState(false);
  const [isLoadingBalances, setIsLoadingBalances] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState<'aztec' | 'base' | null>(null);
  const [showBalanceBreakdown, setShowBalanceBreakdown] = useState(false);
  const [showDepositWizard, setShowDepositWizard] = useState(false);

  // Unified balance = Aztec private + pending burner funds
  const unifiedBalance = privateBalance + burnerBalance;

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

  // Auto-connect Aztec when MetaMask connects:
  // - If cached keys exist in sessionStorage → reconnect silently (no popup)
  // - If no cached keys and walletClient ready → derive via MetaMask signature (first time)
  // Uses a ref guard (not state) to prevent the state update from cancelling the async work.
  useEffect(() => {
    if (!mounted || !isEvmConnected || !evmAddress || isAztecConnected) return;
    if (connectingRef.current) return;
    connectingRef.current = true;

    (async () => {
      const { hasCachedKeys, reconnectEmbeddedWallet, connectEmbeddedWallet } = await import('@/lib/aztec/embeddedWallet');

      if (hasCachedKeys(evmAddress)) {
        // Reconnect from cached keys — no MetaMask popup
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
      } else if (walletClient) {
        // First time — derive via MetaMask signature
        console.log('[Layout] First connection — deriving Aztec wallet...');
        setIsConnectingAztec(true);
        setAztecError(null);
        try {
          const signMessage = async (message: string): Promise<Hex> => {
            return await walletClient.signMessage({
              account: evmAddress,
              message,
            }) as Hex;
          };
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
      } else {
        // walletClient not ready yet — will retry when it becomes available
        connectingRef.current = false;
      }
    })();
  }, [mounted, isEvmConnected, evmAddress, walletClient, isAztecConnected, setAztecConnected, setAztecError]);

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

      // Scan burners for stuck funds (only on forced refresh or first load)
      if (publicClient && walletClient && evmAddress && TOKENS.base.address) {
        try {
          const result = await scanAndRecover(
            walletClient,
            evmAddress as Hex,
            publicClient,
            TOKENS.base.address as Hex,
            getSmartAccountAddress,
          );
          const totalBurner = result.fundedBurners.reduce((sum, b) => sum + b.balance, 0n);
          setBurnerBalance(totalBurner);
          if (totalBurner > 0n) {
            console.log('[Layout] Stuck burner balance:', formatTokenAmount(totalBurner));
          }
        } catch (e) {
          // Burner scan is best-effort
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
    if (mounted && (isAztecConnected || isEvmConnected) && !isAztecTxPending) {
      const initialTimeout = setTimeout(() => {
        fetchBalances();
      }, 2000);
      const pollInterval = setInterval(() => {
        fetchBalances();
      }, TIMING.balancePollInterval);

      return () => {
        clearTimeout(initialTimeout);
        clearInterval(pollInterval);
      };
    }
  }, [fetchBalances, mounted, isAztecConnected, isEvmConnected, isAztecTxPending]);

  const handleDisconnect = async () => {
    try {
      const { disconnectEmbeddedWallet } = await import('@/lib/aztec/embeddedWallet');
      await disconnectEmbeddedWallet();
    } catch (e) {}
    disconnectAztec();
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

  return (
    <div className="min-h-screen bg-black text-gray-300 font-mono relative">
      <div className="starfield" />
      {/* Header */}
      <header className="border-b border-gray-900 px-4 py-3 relative z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="text-white hover:opacity-80">zkzkp2p</a>
            {isEvmConnected && (
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
                    <>
                      <button
                        onClick={() => copyToClipboard(aztecAddress, 'aztec')}
                        className="text-sm hover:text-white cursor-pointer transition-colors"
                        title="Click to copy full address"
                      >
                        {copiedAddress === 'aztec' ? 'copied!' : shortenAddress(aztecAddress || '')}
                      </button>
                      {isAztecDeployed === true && (
                        <span className="text-green-500 text-xs" title="Account deployed on-chain">&#10003;</span>
                      )}
                      {isAztecDeployed === false && !isDeployingAztec && (
                        <button
                          onClick={async () => {
                            try {
                              const { deployAztecAccount } = await import('@/lib/aztec/embeddedWallet');
                              await deployAztecAccount();
                            } catch (e: any) {
                              setAztecError(`Deploy failed: ${e.message}`);
                            }
                          }}
                          className="text-xs text-yellow-500 hover:text-yellow-300 border border-yellow-800 hover:border-yellow-500 px-1.5 py-0.5 transition-colors"
                          title="Deploy account on-chain (required for private transfers)"
                        >
                          deploy
                        </button>
                      )}
                      {isDeployingAztec && (
                        <span className="text-xs text-yellow-500 animate-pulse">deploying...</span>
                      )}
                    </>
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
            {/* Balance moved to main content area */}
            {!isEvmConnected && (
              <ConnectButton.Custom>
                {({ openConnectModal }) => (
                  <button
                    onClick={openConnectModal}
                    className="px-4 py-1.5 bg-white text-black text-sm rounded-full hover:bg-gray-200 disabled:opacity-50 transition-colors"
                  >
                    login
                  </button>
                )}
              </ConnectButton.Custom>
            )}
            {isEvmConnected && (
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
        {!isEvmConnected ? (
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
          <div className="max-w-lg mx-auto space-y-6">
            {/* Wallet Balance — Big Display */}
            <div className="text-center space-y-2 py-6">
              <div className="text-gray-500 text-xs uppercase tracking-wider">private balance</div>
              <div className="flex items-center justify-center gap-3">
                <span className="text-4xl text-white font-light">{formatTokenAmount(unifiedBalance)}</span>
                <span className="text-gray-500 text-lg">USDC</span>
              </div>
              <div className="flex items-center justify-center gap-3 text-xs">
                {isAztecDeployed === true && (
                  <span className="text-green-700">deployed</span>
                )}
                {isAztecDeployed === false && (
                  <span className="text-yellow-600">not deployed</span>
                )}
                <button
                  onClick={() => fetchBalances(true)}
                  disabled={isLoadingBalances}
                  className="text-gray-600 hover:text-gray-400 disabled:opacity-50"
                >
                  {isLoadingBalances ? 'syncing...' : 'refresh'}
                </button>
                <button
                  onClick={() => setShowBalanceBreakdown(!showBalanceBreakdown)}
                  className="text-gray-700 hover:text-gray-400"
                >
                  {showBalanceBreakdown ? 'simple' : 'advanced'}
                </button>
              </div>

              {/* Advanced Breakdown */}
              {showBalanceBreakdown && (
                <div className="max-w-xs mx-auto border border-gray-800 p-3 space-y-2 text-xs mt-3">
                  <div className="flex justify-between">
                    <span className="text-gray-500">aztec private</span>
                    <span className="text-gray-300">{formatTokenAmount(privateBalance)} USDC</span>
                  </div>
                  {burnerBalance > 0n && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">pending (burners)</span>
                      <span className="text-gray-300">{formatTokenAmount(burnerBalance)} USDC</span>
                    </div>
                  )}
                  {(burnerBalance > 0n) && (
                    <div className="pt-1">
                      <button className="text-xs text-gray-600 hover:text-gray-400 underline">
                        consolidate to aztec
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="space-y-2">
              <PrivateAccount
                privateBalance={privateBalance}
                publicBalance={publicBalance}
                baseBalance={baseBalance}
                burnerBalance={burnerBalance}
                isEvmConnected={isEvmConnected}
                onTopUp={fetchBalances}
              />

              {!showDepositWizard ? (
                <button
                  onClick={() => setShowDepositWizard(true)}
                  disabled={unifiedBalance <= 0n}
                  className="w-full py-3 text-sm border border-gray-700 hover:border-gray-500 hover:text-white disabled:opacity-30 transition-colors"
                >
                  deposit on peer.xyz
                </button>
              ) : (
                <CreateDeposit
                  privateBalance={unifiedBalance}
                  onRefreshBalances={fetchBalances}
                  onClose={() => setShowDepositWizard(false)}
                />
              )}
            </div>

            {/* Active Deposits on peer.xyz */}
            {evmAddress && (
              <MyDeposits ownerAddress={evmAddress} />
            )}

            <TransactionHistory />
          </div>
        )}
      </main>
    </div>
  );
}
