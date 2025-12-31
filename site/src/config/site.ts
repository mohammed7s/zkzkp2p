type NavItem = {
  label: string;
  href: string;
  external?: boolean;
};

export const siteConfig = {
  name: 'zkzkp2p',
  description: 'Private liquidity for peer-to-peer payments',
  tagline: 'Fund zkp2p deposits without revealing your identity',

  links: {
    github: 'https://github.com/zkzkp2p/zkzkp2p',
    docs: '/docs',
    app: '/app',
    zkp2p: 'https://zkp2p.xyz',
    aztec: 'https://aztec.network',
    train: 'https://github.com/TrainProtocol/contracts',
  },

  nav: [
    { label: 'docs', href: '/docs' },
    { label: 'app', href: '/app' },
    { label: 'github', href: 'https://github.com/zkzkp2p/zkzkp2p', external: true },
  ] as NavItem[],
};
