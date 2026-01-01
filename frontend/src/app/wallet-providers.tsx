'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { config } from '@/lib/wagmi';
import { useState, useEffect } from 'react';

import '@rainbow-me/rainbowkit/styles.css';

// Initialize Aztec wallet on client side
function InitializeAztecWallet() {
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        if ((window as any).azguard) {
          console.log('Azguard wallet detected');
        }
      } catch (err) {
        // Silently ignore
      }
    }, 500);

    return () => clearTimeout(timer);
  }, []);

  return null;
}

export function WalletProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme()}>
          <InitializeAztecWallet />
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
