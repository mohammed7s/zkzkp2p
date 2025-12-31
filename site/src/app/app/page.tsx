'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ConnectWallet } from '@/components/app/ConnectWallet';

type ConnectionMethod = 'zkp2p' | 'metamask' | 'walletconnect' | 'azguard' | 'import-zkp2p';

type WalletState = {
  method: ConnectionMethod | null;
  address: string | null;
};

function WalletDropdown({
  address,
  onDisconnect,
}: {
  address: string;
  onDisconnect: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 border border-gray-700 rounded hover:border-gray-500 font-mono text-sm"
      >
        <span className="w-2 h-2 bg-[#4ADE80] rounded-full" />
        {shortAddress}
        <svg width="12" height="12" viewBox="0 0 12 12" className="text-gray-500">
          <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-64 bg-[#0a0a0a] border border-[#1a1a1a] z-50">
            <div className="p-3 border-b border-[#1a1a1a]">
              <p className="text-xs text-gray-500 mb-1">connected</p>
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm">{shortAddress}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(address)}
                  className="text-xs text-gray-500 hover:text-white font-mono"
                >
                  [copy]
                </button>
              </div>
            </div>

            <div className="p-3 border-b border-[#1a1a1a]">
              <p className="text-xs text-gray-500 mb-2">recent</p>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between text-gray-400">
                  <span>+50 USDC added</span>
                  <span className="text-gray-600">2h ago</span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>deposit created</span>
                  <span className="text-gray-600">1d ago</span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>-100 USDC withdraw</span>
                  <span className="text-gray-600">3d ago</span>
                </div>
              </div>
            </div>

            <div className="p-3">
              <button
                onClick={onDisconnect}
                className="w-full text-xs text-gray-500 hover:text-red-400 font-mono text-center"
              >
                [disconnect]
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Dashboard({
  address,
  onDisconnect,
}: {
  address: string;
  onDisconnect: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('EUR');

  // Mock data
  const privateBalance = '420.00';
  const rate = 0.92;
  const orders = [
    { id: 1, amount: 100, status: 'LIVE' },
    { id: 2, amount: 50, status: 'PENDING' },
  ];

  return (
    <>
      {/* Header with wallet */}
      <header className="border-b border-[#1a1a1a] px-6 py-3">
        <div className="flex items-center justify-between">
          <Link href="/" className="hover:opacity-80">
            <Image
              src="/logos/wordmark.svg"
              alt="zkzkp2p"
              width={140}
              height={22}
              className="h-5 w-auto"
            />
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/docs" className="text-sm text-gray-500 hover:text-white font-mono">
              docs
            </Link>
            <WalletDropdown address={address} onDisconnect={onDisconnect} />
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 p-6">
        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Left Column */}
            <div className="space-y-6">
              {/* Private Wallet Card */}
              <div className="border border-[#1a1a1a] p-6">
                <p className="text-xs text-gray-500 font-mono mb-4">[private wallet]</p>
                <div className="mb-6">
                  <span className="text-3xl font-mono">${privateBalance}</span>
                  <span className="text-gray-500 ml-2">USDC</span>
                </div>
                <div className="flex gap-3">
                  <button className="flex-1 py-2 border border-gray-700 text-sm font-mono hover:border-[#4ADE80] hover:text-[#4ADE80]">
                    [+ add]
                  </button>
                  <button className="flex-1 py-2 border border-gray-700 text-sm font-mono hover:border-gray-500 hover:text-white">
                    [withdraw]
                  </button>
                </div>
              </div>

              {/* Active Orders Card */}
              <div className="border border-[#1a1a1a] p-6">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs text-gray-500 font-mono">[orders]</p>
                  <span className="text-xs text-gray-600">({orders.length})</span>
                </div>
                {orders.length > 0 ? (
                  <div className="space-y-3">
                    {orders.map((order) => (
                      <div key={order.id} className="flex items-center justify-between py-2 border-b border-[#1a1a1a] last:border-0">
                        <span className="font-mono text-sm">${order.amount} USDC</span>
                        <span className={`text-xs font-mono ${
                          order.status === 'LIVE' ? 'text-[#4ADE80]' : 'text-yellow-500'
                        }`}>
                          {order.status}
                        </span>
                      </div>
                    ))}
                    <button className="w-full text-xs text-gray-500 hover:text-white font-mono pt-2">
                      [view all orders]
                    </button>
                  </div>
                ) : (
                  <p className="text-sm text-gray-600 font-mono">no active orders</p>
                )}
              </div>
            </div>

            {/* Right Column - Swapbox */}
            <div className="border border-[#1a1a1a] p-6 h-fit">
              <p className="text-xs text-gray-500 font-mono mb-6">[deposit to zkp2p]</p>

              <div className="mb-4">
                <label className="text-xs text-gray-600 block mb-2 font-mono">amount</label>
                <div className="flex">
                  <input
                    type="text"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 bg-[#111] border border-[#222] px-4 py-3 text-lg font-mono focus:border-[#4ADE80] outline-none"
                  />
                  <span className="bg-[#1a1a1a] border border-l-0 border-[#222] px-4 py-3 text-gray-500 font-mono">
                    USDC
                  </span>
                </div>
                <p className="text-xs text-gray-600 mt-2 font-mono">
                  available: ${privateBalance} USDC
                </p>
              </div>

              <div className="mb-4">
                <label className="text-xs text-gray-600 block mb-2 font-mono">receive</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full bg-[#111] border border-[#222] px-4 py-3 font-mono focus:border-[#4ADE80] outline-none appearance-none cursor-pointer"
                >
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="USD">USD</option>
                </select>
              </div>

              <div className="mb-6 py-3 border-t border-b border-[#1a1a1a]">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 font-mono">rate</span>
                  <span className="font-mono">1 USDC = €{rate.toFixed(2)}</span>
                </div>
                {amount && (
                  <div className="flex justify-between text-sm mt-2">
                    <span className="text-gray-500 font-mono">you receive</span>
                    <span className="font-mono text-[#4ADE80]">
                      €{(parseFloat(amount || '0') * rate).toFixed(2)}
                    </span>
                  </div>
                )}
              </div>

              <button className="w-full py-4 bg-[#4ADE80] text-black font-mono hover:bg-[#22c55e] text-lg">
                [create deposit]
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default function AppPage() {
  const [wallet, setWallet] = useState<WalletState>({
    method: null,
    address: null,
  });

  const handleConnect = (method: ConnectionMethod) => {
    const mockAddresses: Record<ConnectionMethod, string> = {
      zkp2p: '0x1234567890abcdef1234567890abcdef12345678',
      metamask: '0xabcdef1234567890abcdef1234567890abcdef12',
      walletconnect: '0x9876543210fedcba9876543210fedcba98765432',
      azguard: '0xaz1234567890abcdef1234567890abcdef123456',
      'import-zkp2p': '0ximp0rt3d1234567890abcdef1234567890abcd',
    };

    setWallet({
      method,
      address: mockAddresses[method],
    });
  };

  const disconnect = () => {
    setWallet({ method: null, address: null });
  };

  const isConnected = wallet.address !== null;

  if (!isConnected) {
    return <ConnectWallet onConnect={handleConnect} connected={false} />;
  }

  return <Dashboard address={wallet.address} onDisconnect={disconnect} />;
}
