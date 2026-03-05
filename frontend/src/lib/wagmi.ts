import { createConfig } from '@privy-io/wagmi';
import { http } from 'viem';
import { base } from 'viem/chains';

export const config = createConfig({
  chains: [base],
  transports: {
    [base.id]: http(),
  },
});
