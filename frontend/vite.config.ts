import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';
import fs from 'fs';

const AZTEC_NOIR_ACVM_V4 = path.resolve(
  __dirname,
  'node_modules/.pnpm/@aztec+noir-acvm_js@4.0.0-devnet.2-patch.1/node_modules/@aztec/noir-acvm_js'
);
const AZTEC_NOIR_NOIRC_ABI_V4 = path.resolve(
  __dirname,
  'node_modules/.pnpm/@aztec+noir-noirc_abi@4.0.0-devnet.2-patch.1/node_modules/@aztec/noir-noirc_abi'
);

/**
 * Aztec WASM serving plugin.
 *
 * The Aztec SDK uses `new URL("acvm_js_bg.wasm", import.meta.url)` and similar
 * patterns to load WASM files. When Vite pre-bundles these deps into .vite/deps/,
 * import.meta.url points to the bundled JS file, so the WASM URL resolves to
 * e.g. /node_modules/.vite/deps/acvm_js_bg.wasm — which doesn't exist.
 * Vite's SPA fallback then serves index.html, causing a "expected magic word" error.
 *
 * This plugin intercepts those requests and serves the actual WASM files from node_modules.
 */
function aztecWasmPlugin(): Plugin {
  // Locate Aztec WASM files in node_modules/.pnpm at config time.
  // pnpm doesn't hoist @aztec/noir-acvm_js or @aztec/noir-noirc_abi,
  // so we find them via execSync at startup.
  const wasmMap: Record<string, string> = {};

  try {
    const { execSync } = require('child_process');
    const root = path.resolve(__dirname, 'node_modules');
    const result = execSync(
      `find ${root}/.pnpm -path "*/web/acvm_js_bg.wasm" -o -path "*/web/noirc_abi_wasm_bg.wasm" 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    for (const line of result.split('\n').filter(Boolean)) {
      const name = path.basename(line);
      // Prefer the version used by @aztec/wallets (4.0.0-devnet.2-patch.1)
      // over older versions. If multiple exist, pick the one with highest version.
      if (!wasmMap[name] || line.includes('4.0.0')) {
        wasmMap[name] = line;
      }
    }
  } catch {}

  return {
    name: 'aztec-wasm',
    configureServer(server) {
      console.log('[aztec-wasm] Resolved WASM files:', wasmMap);

      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        for (const [wasmName, filePath] of Object.entries(wasmMap)) {
          if (url.endsWith(wasmName)) {
            res.setHeader('Content-Type', 'application/wasm');
            // Prevent stale wasm/js glue mismatches during local development.
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }
        if (url.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    aztecWasmPlugin(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util', 'url', 'assert', 'http', 'https', 'os', 'path', 'zlib', 'process'],
      globals: { Buffer: true, process: true },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Force all Aztec Noir wasm packages to one version (v4).
      // Prevents mixed v2/v4 wasm-bindgen glue in the same Vite bundle.
      '@aztec/noir-acvm_js': AZTEC_NOIR_ACVM_V4,
      '@aztec/noir-noirc_abi': AZTEC_NOIR_NOIRC_ABI_V4,
    },
  },
  // Use NEXT_PUBLIC_ prefix so we don't need to rename all env vars
  envPrefix: 'NEXT_PUBLIC_',
  server: {
    port: 3000,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
    // Keep problematic wasm-heavy deps out of prebundle to avoid mixed-version glue.
    exclude: [
      '@aztec/bb.js',
      '@nemi-fi/wallet-sdk',
      '@aztec/noir-acvm_js',
      '@aztec/noir-noirc_abi',
    ],
  },
  // Ensure .wasm files are treated as assets
  assetsInclude: ['**/*.wasm'],
});
