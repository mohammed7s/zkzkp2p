/** @type {import('next').NextConfig} */
const webpack = require('webpack');
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  // Transpile Aztec packages for ESM/CommonJS compatibility
  transpilePackages: [
    '@aztec/wallets',
    '@aztec/aztec.js',
    '@aztec/foundation',
    '@aztec/pxe',
    '@aztec/kv-store',
    '@aztec/wallet-sdk',
    '@aztec/stdlib',
    '@aztec/bb-prover',
    '@aztec/accounts',
    '@aztec/entrypoints',
    '@aztec/protocol-contracts',
    '@aztec/simulator',
  ],
  // No COOP/COEP headers — Privy's iframe requires it.
  // bb.js BarretenbergSync needs SharedArrayBuffer (COOP: same-origin) but that
  // blocks Privy. This is a known conflict. See embeddedWallet.ts for workaround.
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      // Resolve SDK from vendored copy
      '@substancelabs/aztec-evm-bridge-sdk': path.resolve(
        __dirname,
        'vendor/substance-sdk/dist/index.js'
      ),
    };

    // Add polyfills for Node.js built-ins in the browser
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: require.resolve('buffer'),
        crypto: require.resolve('crypto-browserify'),
        stream: require.resolve('stream-browserify'),
        util: require.resolve('util'),
        url: require.resolve('url'),
        assert: require.resolve('assert'),
        http: require.resolve('stream-http'),
        https: require.resolve('https-browserify'),
        os: require.resolve('os-browserify/browser'),
        path: require.resolve('path-browserify'),
        zlib: require.resolve('browserify-zlib'),
        fs: false,
        net: false,
        tls: false,
        '@react-native-async-storage/async-storage': false,
      };

      // Provide Buffer and process globally
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ['buffer', 'Buffer'],
          process: 'process/browser',
        })
      );

      // Enable WASM support for bb.js/bb-prover
      config.experiments = {
        ...config.experiments,
        asyncWebAssembly: true,
        layers: true,
      };
    }

    return config;
  },
};

module.exports = nextConfig;
