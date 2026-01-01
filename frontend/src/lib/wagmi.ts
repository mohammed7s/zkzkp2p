import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { baseSepolia, base } from 'wagmi/chains';

export const config = getDefaultConfig({
  appName: 'zkzkp2p',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'demo',
  chains: [baseSepolia, base],
  ssr: true,
});
