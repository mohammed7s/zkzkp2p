import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { config } from '@/lib/wagmi';
import { Layout } from '@/components/Layout';

import '@rainbow-me/rainbowkit/styles.css';

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-black text-gray-300 font-mono">
      <div className="max-w-2xl mx-auto px-4 py-20 text-center">
        <h1 className="text-2xl text-white">zkzkp2p</h1>
        <p className="text-gray-500 text-sm mt-2">loading...</p>
      </div>
    </div>
  );
}

export function App() {
  const [mounted, setMounted] = useState(false);
  const [queryClient] = useState(() => new QueryClient());

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <LoadingScreen />;
  }

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme()}>
          <Layout />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
