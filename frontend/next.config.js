/** @type {import('next').NextConfig} */
const webpack = require('webpack');
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  // Transpile Aztec and wallet packages for ESM/CommonJS compatibility
  transpilePackages: [
    '@azguardwallet/aztec-wallet',
    '@azguardwallet/client',
    '@substancelabs/aztec-evm-bridge-sdk',
  ],
  // Don't bundle Aztec packages on the server - use native Node.js require
  // This prevents WASM worker bundling issues in API routes
  experimental: {
    serverComponentsExternalPackages: [
      '@aztec/aztec.js',
      '@aztec/foundation',
      '@aztec/bb.js',
      '@aztec/circuits.js',
    ],
  },
  webpack: (config, { isServer }) => {
    // Fix for @azguardwallet/client exports field issue
    // The package has "default" before "types" which violates Node.js resolution
    config.resolve.alias = {
      ...config.resolve.alias,
      '@azguardwallet/client': path.resolve(
        __dirname,
        'node_modules/@azguardwallet/client/dist/index.js'
      ),
      // Resolve SDK from adjacent repo (file: dependency with pnpm symlinks)
      '@substancelabs/aztec-evm-bridge-sdk': path.resolve(
        __dirname,
        '../../substance-aztec-evm-bridge/packages/sdk/dist/index.mjs'
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
        // React Native modules not needed in browser
        '@react-native-async-storage/async-storage': false,
      };

      // Provide Buffer and process globally
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ['buffer', 'Buffer'],
          process: 'process/browser',
        })
      );
    }

    return config;
  },
};

module.exports = nextConfig;
