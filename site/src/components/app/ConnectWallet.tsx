import Image from 'next/image';

type ConnectionMethod = 'zkp2p' | 'metamask' | 'walletconnect' | 'azguard' | 'import-zkp2p';

type Props = {
  onConnect: (method: ConnectionMethod) => void;
  connected: boolean;
};

function MetaMaskIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M21.3 2L13.1 8.2L14.6 4.5L21.3 2Z" fill="#E17726"/>
      <path d="M2.7 2L10.8 8.3L9.4 4.5L2.7 2Z" fill="#E27625"/>
      <path d="M18.4 16.8L16.3 20.1L20.8 21.4L22.2 16.9L18.4 16.8Z" fill="#E27625"/>
      <path d="M1.8 16.9L3.2 21.4L7.7 20.1L5.6 16.8L1.8 16.9Z" fill="#E27625"/>
      <path d="M7.5 10.7L6.1 12.8L10.6 13L10.4 8.1L7.5 10.7Z" fill="#E27625"/>
      <path d="M16.5 10.7L13.5 8L13.4 13L17.9 12.8L16.5 10.7Z" fill="#E27625"/>
      <path d="M7.7 20.1L10.3 18.8L8 16.9L7.7 20.1Z" fill="#E27625"/>
      <path d="M13.7 18.8L16.3 20.1L16 16.9L13.7 18.8Z" fill="#E27625"/>
      <path d="M16.3 20.1L13.7 18.8L13.9 20.6L13.9 21.3L16.3 20.1Z" fill="#D5BFB2"/>
      <path d="M7.7 20.1L10.1 21.3L10.1 20.6L10.3 18.8L7.7 20.1Z" fill="#D5BFB2"/>
      <path d="M10.2 15.4L7.9 14.7L9.5 14L10.2 15.4Z" fill="#233447"/>
      <path d="M13.8 15.4L14.5 14L16.1 14.7L13.8 15.4Z" fill="#233447"/>
      <path d="M7.7 20.1L8 16.8L5.6 16.9L7.7 20.1Z" fill="#CC6228"/>
      <path d="M16 16.8L16.3 20.1L18.4 16.9L16 16.8Z" fill="#CC6228"/>
      <path d="M17.9 12.8L13.4 13L13.8 15.4L14.5 14L16.1 14.7L17.9 12.8Z" fill="#CC6228"/>
      <path d="M7.9 14.7L9.5 14L10.2 15.4L10.6 13L6.1 12.8L7.9 14.7Z" fill="#CC6228"/>
      <path d="M6.1 12.8L8 16.9L7.9 14.7L6.1 12.8Z" fill="#E27525"/>
      <path d="M16.1 14.7L16 16.9L17.9 12.8L16.1 14.7Z" fill="#E27525"/>
      <path d="M10.6 13L10.2 15.4L10.7 17.9L10.8 14.5L10.6 13Z" fill="#E27525"/>
      <path d="M13.4 13L13.2 14.5L13.3 17.9L13.8 15.4L13.4 13Z" fill="#E27525"/>
      <path d="M13.8 15.4L13.3 17.9L13.7 18.8L16 16.9L16.1 14.7L13.8 15.4Z" fill="#F5841F"/>
      <path d="M7.9 14.7L8 16.9L10.3 18.8L10.7 17.9L10.2 15.4L7.9 14.7Z" fill="#F5841F"/>
      <path d="M13.9 21.3L13.9 20.6L13.7 20.4H10.3L10.1 20.6L10.1 21.3L7.7 20.1L8.6 20.8L10.3 22H13.7L15.4 20.8L16.3 20.1L13.9 21.3Z" fill="#C0AC9D"/>
      <path d="M13.7 18.8L13.3 17.9H10.7L10.3 18.8L10.1 20.6L10.3 20.4H13.7L13.9 20.6L13.7 18.8Z" fill="#161616"/>
      <path d="M21.7 8.5L22.4 5.1L21.3 2L13.7 7.8L16.5 10.7L20.6 11.9L21.7 10.6L21.2 10.2L22 9.5L21.4 9L22.2 8.4L21.7 8.5Z" fill="#763E1A"/>
      <path d="M1.6 5.1L2.3 8.5L1.8 8.4L2.6 9L2 9.5L2.8 10.2L2.3 10.6L3.4 11.9L7.5 10.7L10.3 7.8L2.7 2L1.6 5.1Z" fill="#763E1A"/>
      <path d="M20.6 11.9L16.5 10.7L17.9 12.8L16 16.9L18.4 16.8H22.2L20.6 11.9Z" fill="#F5841F"/>
      <path d="M7.5 10.7L3.4 11.9L1.8 16.8H5.6L8 16.9L6.1 12.8L7.5 10.7Z" fill="#F5841F"/>
      <path d="M13.4 13L13.7 7.8L14.6 4.5H9.4L10.3 7.8L10.6 13L10.7 14.5L10.7 17.9H13.3L13.3 14.5L13.4 13Z" fill="#F5841F"/>
    </svg>
  );
}

function WalletConnectIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M6.09 8.61C9.36 5.46 14.64 5.46 17.91 8.61L18.3 8.99C18.46 9.14 18.46 9.39 18.3 9.55L16.96 10.84C16.88 10.92 16.75 10.92 16.67 10.84L16.13 10.32C13.85 8.12 10.15 8.12 7.87 10.32L7.29 10.88C7.21 10.96 7.08 10.96 7 10.88L5.66 9.59C5.5 9.44 5.5 9.19 5.66 9.03L6.09 8.61ZM20.66 11.27L21.85 12.42C22.01 12.57 22.01 12.82 21.85 12.98L16.55 18.13C16.39 18.29 16.13 18.29 15.97 18.13L12.24 14.51C12.2 14.47 12.14 14.47 12.1 14.51L8.37 18.13C8.21 18.29 7.95 18.29 7.79 18.13L2.15 12.98C1.99 12.82 1.99 12.57 2.15 12.42L3.34 11.27C3.5 11.11 3.76 11.11 3.92 11.27L7.65 14.89C7.69 14.93 7.75 14.93 7.79 14.89L11.52 11.27C11.68 11.11 11.94 11.11 12.1 11.27L15.83 14.89C15.87 14.93 15.93 14.93 15.97 14.89L19.7 11.27C19.86 11.11 20.12 11.11 20.28 11.27L20.66 11.27Z" fill="#3B99FC"/>
    </svg>
  );
}

function AzguardIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L3 6V12C3 17.5 6.8 22.7 12 24C17.2 22.7 21 17.5 21 12V6L12 2Z" fill="#A855F7" fillOpacity="0.2" stroke="#A855F7" strokeWidth="1.5"/>
      <path d="M12 7L8 9V13C8 15.5 9.6 17.8 12 18.5C14.4 17.8 16 15.5 16 13V9L12 7Z" fill="#A855F7"/>
    </svg>
  );
}

function Zkp2pIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 200 200" fill="none">
      <defs>
        <linearGradient id="pGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#4ADE80"/>
          <stop offset="22%" stopColor="#FFD93D"/>
          <stop offset="42%" stopColor="#FF6B6B"/>
          <stop offset="68%" stopColor="#A855F7"/>
          <stop offset="100%" stopColor="#1a1a2e"/>
        </linearGradient>
      </defs>
      <path d="M50 22 L50 178 L72 178 L72 105 L105 105 Q152 105 152 63.5 Q152 22 105 22 Z M72 88 L72 39 L100 39 Q127 39 127 63.5 Q127 88 100 88 Z"
            fill="url(#pGrad)"/>
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 3v12m0 0l-4-4m4 4l4-4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" strokeLinecap="round"/>
    </svg>
  );
}

export function ConnectWallet({ onConnect, connected }: Props) {
  return (
    <div className="flex-1 flex items-center justify-center px-4 py-20">
      <div className="max-w-sm w-full">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Image
            src="/logos/wordmark.svg"
            alt="zkzkp2p"
            width={200}
            height={32}
            className="h-8 w-auto"
          />
        </div>

        {/* Connect Options */}
        <div className="border border-[#1a1a1a] p-6 space-y-3">
          <button
            onClick={() => onConnect('zkp2p')}
            disabled={connected}
            className="w-full py-3 px-4 border border-gray-700 text-sm text-gray-300 hover:border-[#4ADE80] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
          >
            <Zkp2pIcon />
            <span className="font-mono">zkp2p</span>
          </button>

          <button
            onClick={() => onConnect('metamask')}
            disabled={connected}
            className="w-full py-3 px-4 border border-gray-700 text-sm text-gray-300 hover:border-orange-500 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
          >
            <MetaMaskIcon />
            <span className="font-mono">metamask</span>
          </button>

          <button
            onClick={() => onConnect('walletconnect')}
            disabled={connected}
            className="w-full py-3 px-4 border border-gray-700 text-sm text-gray-300 hover:border-blue-500 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
          >
            <WalletConnectIcon />
            <span className="font-mono">walletconnect</span>
          </button>

          <button
            onClick={() => onConnect('azguard')}
            disabled={connected}
            className="w-full py-3 px-4 border border-gray-700 text-sm text-gray-300 hover:border-[#A855F7] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
          >
            <AzguardIcon />
            <span className="font-mono">azguard</span>
          </button>

          <div className="border-t border-[#1a1a1a] pt-3 mt-3">
            <button
              onClick={() => onConnect('import-zkp2p')}
              disabled={connected}
              className="w-full py-3 px-4 border border-gray-700 text-sm text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
            >
              <ImportIcon />
              <span className="font-mono">import zkp2p wallet</span>
            </button>
          </div>
        </div>

        {/* Info */}
        <p className="text-center text-xs text-gray-600 mt-6 font-mono">
          [testnet only]
        </p>
      </div>
    </div>
  );
}
