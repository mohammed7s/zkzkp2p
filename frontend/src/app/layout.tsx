import type { Metadata } from 'next';
import nextDynamic from 'next/dynamic';
import './globals.css';

// Force dynamic rendering - prevent static generation
// This is needed because wagmi/zustand use browser APIs (indexedDB)
export const dynamic = 'force-dynamic';

// Dynamically import Providers with SSR disabled
// This prevents wallet libraries from running on the server
const Providers = nextDynamic(() => import('./providers').then(mod => mod.Providers), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-black text-gray-300 font-mono">
      <div className="max-w-2xl mx-auto px-4 py-20 text-center">
        <h1 className="text-2xl text-white">zkzkp2p</h1>
        <p className="text-gray-500 text-sm mt-2">loading...</p>
      </div>
    </div>
  ),
});

export const metadata: Metadata = {
  title: 'zkzkp2p - Private Liquidity for zkp2p',
  description: 'Privacy-preserving liquidity for zkp2p via Aztec',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
