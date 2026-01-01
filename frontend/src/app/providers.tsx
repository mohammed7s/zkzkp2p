'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';

// Loading placeholder
function LoadingScreen() {
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

// Dynamically import wallet providers - only loads on client, no SSR
const WalletProviders = dynamic(
  () => import('./wallet-providers').then((mod) => mod.WalletProviders),
  { ssr: false, loading: () => <LoadingScreen /> }
);

export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <LoadingScreen />;
  }

  return <WalletProviders>{children}</WalletProviders>;
}
