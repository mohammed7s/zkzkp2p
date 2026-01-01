'use client';

import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useWalletStore } from '@/stores/walletStore';
import { useState, useEffect } from 'react';

function shortenAddress(address: string, chars = 4): string {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function Header() {
  const { address: evmAddress, isConnected: isEvmConnected } = useAccount();
  const { aztecAddress, isAztecConnected, setAztecConnected, setAztecError } = useWalletStore();
  const [isConnectingAztec, setIsConnectingAztec] = useState(false);
  const [isAzguardAvailable, setIsAzguardAvailable] = useState(false);

  useEffect(() => {
    const checkAzguard = async () => {
      try {
        const { isAzguardInstalled } = await import('@/lib/aztec/azguardHelpers');
        const installed = await isAzguardInstalled();
        setIsAzguardAvailable(installed);
      } catch {
        setIsAzguardAvailable(false);
      }
    };
    checkAzguard();
  }, []);

  const handleConnectAztec = async () => {
    if (isConnectingAztec) return;
    setIsConnectingAztec(true);
    setAztecError(null);

    try {
      const { connectAzguard } = await import('@/lib/aztec/azguardHelpers');
      const result = await connectAzguard();
      if (result) {
        // Store both address (for display/contract args) and caipAccount (for Azguard operations)
        setAztecConnected(result.address, result.caipAccount, result.client);
      }
    } catch (error: any) {
      setAztecError(error.message || 'Failed to connect Aztec wallet');
    } finally {
      setIsConnectingAztec(false);
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-gray-950/80 backdrop-blur-md border-b border-gray-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
              <span className="text-white font-bold text-sm">zk</span>
            </div>
            <span className="font-bold text-xl">zkzkp2p</span>
          </div>

          {/* Wallet Connections */}
          <div className="flex items-center gap-3">
            {/* Aztec Wallet */}
            {isAzguardAvailable && (
              isAztecConnected ? (
                <div className="flex items-center gap-2 px-3 py-2 bg-purple-900/30 border border-purple-700/50 rounded-lg">
                  <div className="w-2 h-2 rounded-full bg-purple-400" />
                  <span className="text-sm text-purple-300 font-mono">
                    {shortenAddress(aztecAddress || '')}
                  </span>
                </div>
              ) : (
                <button
                  onClick={handleConnectAztec}
                  disabled={isConnectingAztec}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 rounded-lg text-sm font-medium transition-colors"
                >
                  {isConnectingAztec ? 'Connecting...' : 'Connect Aztec'}
                </button>
              )
            )}

            {/* EVM Wallet (RainbowKit) */}
            <ConnectButton.Custom>
              {({ account, chain, openConnectModal, openAccountModal, mounted }) => {
                const connected = mounted && account && chain;

                return (
                  <div>
                    {connected ? (
                      <button
                        onClick={openAccountModal}
                        className="flex items-center gap-2 px-3 py-2 bg-blue-900/30 border border-blue-700/50 rounded-lg hover:bg-blue-900/50 transition-colors"
                      >
                        <div className="w-2 h-2 rounded-full bg-blue-400" />
                        <span className="text-sm text-blue-300 font-mono">
                          {account.displayName}
                        </span>
                      </button>
                    ) : (
                      <button
                        onClick={openConnectModal}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
                      >
                        Connect Base
                      </button>
                    )}
                  </div>
                );
              }}
            </ConnectButton.Custom>
          </div>
        </div>
      </div>
    </header>
  );
}
