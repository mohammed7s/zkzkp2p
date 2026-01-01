'use client';

import { useAccount, useDisconnect } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useEffect, useState } from 'react';
import { useWalletStore } from '@/stores/walletStore';

// Utility function - doesn't need dynamic import
function shortenAddress(address: string, chars = 4): string {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function WalletConnect() {
  const { address: evmAddress, isConnected: isEvmConnected } = useAccount();
  const { disconnect: disconnectEvm } = useDisconnect();

  const {
    aztecAddress,
    isAztecConnected,
    azguardClient,
    aztecError,
    setEvmConnected,
    setAztecConnected,
    setAztecError,
    disconnectAztec,
    disconnectAll,
  } = useWalletStore();

  const [isAzguardAvailable, setIsAzguardAvailable] = useState(false);
  const [isConnectingAztec, setIsConnectingAztec] = useState(false);

  // Sync EVM connection state
  useEffect(() => {
    setEvmConnected(evmAddress || null);
  }, [evmAddress, setEvmConnected]);

  // Check if Azguard is installed
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

  // Auto-connect disabled - let user manually connect Aztec wallet
  // TODO: Re-enable once Azguard SDK version compatibility is fixed

  const handleConnectAztec = async () => {
    if (isConnectingAztec) return;

    setIsConnectingAztec(true);
    setAztecError(null);

    try {
      const { connectAzguard, registerAzguardContract } = await import('@/lib/aztec/azguardHelpers');
      const { AZTEC_TRAIN_ADDRESS, AZTEC_TOKEN_ADDRESS } = await import('@/lib/train/contracts');

      const result = await connectAzguard();
      if (result) {
        // Register contracts so we can call methods on them
        // Azguard fetches artifacts from Aztec network registry

        // Register Token contract (needed for balance queries)
        if (AZTEC_TOKEN_ADDRESS) {
          try {
            console.log('[WalletConnect] Registering Token contract...');
            await registerAzguardContract(result.client, AZTEC_TOKEN_ADDRESS);
          } catch (regError) {
            console.warn('[WalletConnect] Could not register Token contract:', regError);
          }
        }

        // Register Train contract (needed for lock/redeem)
        if (AZTEC_TRAIN_ADDRESS) {
          try {
            console.log('[WalletConnect] Registering Train contract...');
            await registerAzguardContract(result.client, AZTEC_TRAIN_ADDRESS);
          } catch (regError) {
            console.warn('[WalletConnect] Could not register Train contract:', regError);
          }
        }

        setAztecConnected(result.address, result.caipAccount, result.client);
      }
    } catch (error: any) {
      setAztecError(error.message || 'Failed to connect Aztec wallet');
    } finally {
      setIsConnectingAztec(false);
    }
  };

  const handleDisconnectAztec = async () => {
    try {
      const { disconnectAzguard } = await import('@/lib/aztec/azguardHelpers');
      if (azguardClient) {
        await disconnectAzguard(azguardClient);
      }
    } catch (err) {
      console.error('Error disconnecting:', err);
    }
    disconnectAztec();
  };

  const handleDisconnectAll = async () => {
    try {
      const { disconnectAzguard } = await import('@/lib/aztec/azguardHelpers');
      if (azguardClient) {
        await disconnectAzguard(azguardClient);
      }
    } catch (err) {
      console.error('Error disconnecting:', err);
    }
    disconnectEvm();
    disconnectAll();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* EVM Wallet Section */}
      <div className="p-4 border rounded-lg bg-gray-900">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-400">Base (L1)</span>
          {isEvmConnected && (
            <span className="text-xs px-2 py-1 bg-green-900 text-green-300 rounded">
              Connected
            </span>
          )}
        </div>
        <ConnectButton />
      </div>

      {/* Aztec Wallet Section */}
      <div className="p-4 border rounded-lg bg-gray-900">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-400">Aztec (L2)</span>
          {isAztecConnected && (
            <span className="text-xs px-2 py-1 bg-purple-900 text-purple-300 rounded">
              Connected
            </span>
          )}
        </div>

        {!isAzguardAvailable ? (
          <div className="text-sm text-gray-500">
            <a
              href="https://azguard.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-400 hover:underline"
            >
              Install Azguard Wallet
            </a>
          </div>
        ) : isAztecConnected ? (
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm">
              {shortenAddress(aztecAddress || '', 6)}
            </span>
            <button
              onClick={handleDisconnectAztec}
              className="text-xs text-red-400 hover:text-red-300"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={handleConnectAztec}
            disabled={isConnectingAztec}
            className="w-full py-2 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 disabled:cursor-not-allowed rounded text-white text-sm"
          >
            {isConnectingAztec ? 'Connecting...' : 'Connect Azguard'}
          </button>
        )}

        {aztecError && (
          <p className="mt-2 text-xs text-red-400">{aztecError}</p>
        )}
      </div>

      {/* Disconnect All */}
      {(isEvmConnected || isAztecConnected) && (
        <button
          onClick={handleDisconnectAll}
          className="text-sm text-gray-500 hover:text-gray-400"
        >
          Disconnect All
        </button>
      )}
    </div>
  );
}
