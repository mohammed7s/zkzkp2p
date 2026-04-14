import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { http } from 'wagmi';
import { BASE_CHAIN, CHAINS } from '@/config';

export const config = getDefaultConfig({
  appName: 'zkzkp2p',
  projectId: import.meta.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'demo',
  chains: [BASE_CHAIN],
  transports: {
    [BASE_CHAIN.id]: http(CHAINS.base.rpcUrl),
  },
  ssr: false,
});
