import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { BASE_CHAIN } from '@/config';

export const config = getDefaultConfig({
  appName: 'zkzkp2p',
  projectId: import.meta.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'demo',
  chains: [BASE_CHAIN],
  ssr: false,
});
