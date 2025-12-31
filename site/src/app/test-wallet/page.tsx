'use client';

import { useState } from 'react';
import { keccak256, toBytes, concat, toHex, hexToBytes } from 'viem';

type DerivedKeys = {
  signingKey: `0x${string}`;
  encryptionKey: `0x${string}`;
  aztecAddress: string | null;
};

type AztecState = {
  connected: boolean;
  pxeUrl: string;
  accountDeployed: boolean;
  address: string | null;
};

export default function TestWalletPage() {
  const [evmAddress, setEvmAddress] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [derivedKeys, setDerivedKeys] = useState<DerivedKeys | null>(null);
  const [aztecState, setAztecState] = useState<AztecState>({
    connected: false,
    pxeUrl: 'http://localhost:8080',
    accountDeployed: false,
    address: null,
  });
  const [logs, setLogs] = useState<string[]>([]);

  const log = (message: string) => {
    console.log(message);
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${message}`]);
  };

  // Step 1: Connect MetaMask
  const connectMetaMask = async () => {
    try {
      log('Requesting MetaMask connection...');

      if (typeof window.ethereum === 'undefined') {
        throw new Error('MetaMask not installed');
      }

      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts'
      }) as string[];

      const address = accounts[0];
      setEvmAddress(address);
      log(`Connected: ${address}`);

    } catch (error: any) {
      log(`Error: ${error.message}`);
    }
  };

  // Step 2: Sign message to derive keys
  const signAndDeriveKeys = async () => {
    if (!evmAddress) return;

    try {
      log('Requesting signature...');

      const message = `Sign to access your zkzkp2p private wallet

Address: ${evmAddress}
Version: 1

This signature will be used to derive your Aztec wallet keys.`;

      const sig = await window.ethereum.request({
        method: 'personal_sign',
        params: [message, evmAddress]
      }) as string;

      setSignature(sig);
      log(`Signature obtained: ${sig.slice(0, 20)}...`);

      // Derive keys
      log('Deriving Aztec keys...');
      const signingKey = keccak256(sig as `0x${string}`);
      const encryptionKey = keccak256(concat([toBytes(sig), toBytes('encryption')]));

      log(`Signing key (secp256k1): ${signingKey.slice(0, 20)}...`);
      log(`Encryption key: ${encryptionKey.slice(0, 20)}...`);

      setDerivedKeys({
        signingKey,
        encryptionKey,
        aztecAddress: null,
      });

      log('Keys derived! Ready to connect to Aztec.');

    } catch (error: any) {
      log(`Error: ${error.message}`);
    }
  };

  // Step 3: Connect to Aztec PXE and create ECDSA account
  const connectToAztec = async () => {
    if (!derivedKeys) return;

    try {
      log(`Connecting to PXE at ${aztecState.pxeUrl}...`);

      // Dynamic import to avoid SSR issues
      const { createPXEClient, Fr } = await import('@aztec/aztec.js');
      const { getEcdsaKAccount } = await import('@aztec/accounts/ecdsa/ecdsa_k');

      const pxe = await createPXEClient(aztecState.pxeUrl);

      // Test connection
      const nodeInfo = await pxe.getNodeInfo();
      log(`Connected to Aztec node v${nodeInfo.nodeVersion}`);
      log(`Chain ID: ${nodeInfo.l1ChainId}`);

      setAztecState(prev => ({ ...prev, connected: true }));

      // Create ECDSA account from derived keys
      log('Creating ECDSA account from derived keys...');

      // Convert hex keys to the format Aztec expects
      const signingPrivateKey = Buffer.from(hexToBytes(derivedKeys.signingKey));
      const encryptionSecretKey = Fr.fromBuffer(Buffer.from(hexToBytes(derivedKeys.encryptionKey)));

      // Get the account manager
      const accountManager = await getEcdsaKAccount(pxe, encryptionSecretKey, signingPrivateKey);

      // Get the would-be address (before deployment)
      const address = accountManager.getAddress();
      log(`Aztec address (derived): ${address.toString()}`);

      setDerivedKeys(prev => prev ? { ...prev, aztecAddress: address.toString() } : null);
      setAztecState(prev => ({ ...prev, address: address.toString() }));

      // Check if account is already deployed
      const isDeployed = await pxe.isContractPubliclyDeployed(address);
      log(`Account deployed: ${isDeployed}`);

      if (isDeployed) {
        setAztecState(prev => ({ ...prev, accountDeployed: true }));
        log('Account already deployed! Ready to use.');
      } else {
        log('Account not deployed yet. Click "Deploy Account" to deploy.');
      }

    } catch (error: any) {
      log(`Error: ${error.message}`);
      console.error(error);
    }
  };

  // Step 4: Deploy the account contract
  const deployAccount = async () => {
    if (!derivedKeys) return;

    try {
      log('Deploying ECDSA account contract...');

      const { createPXEClient, Fr } = await import('@aztec/aztec.js');
      const { getEcdsaKAccount } = await import('@aztec/accounts/ecdsa/ecdsa_k');

      const pxe = await createPXEClient(aztecState.pxeUrl);

      const signingPrivateKey = Buffer.from(hexToBytes(derivedKeys.signingKey));
      const encryptionSecretKey = Fr.fromBuffer(Buffer.from(hexToBytes(derivedKeys.encryptionKey)));

      const accountManager = await getEcdsaKAccount(pxe, encryptionSecretKey, signingPrivateKey);

      log('Sending deployment transaction...');
      const wallet = await accountManager.deploy().wait();

      log(`Account deployed at: ${wallet.getAddress().toString()}`);
      setAztecState(prev => ({ ...prev, accountDeployed: true }));

    } catch (error: any) {
      log(`Error: ${error.message}`);
      console.error(error);
    }
  };

  // Step 5: Sign a test message on Aztec
  const signTestMessage = async () => {
    if (!derivedKeys || !aztecState.accountDeployed) return;

    try {
      log('Creating Aztec wallet instance...');

      const { createPXEClient, Fr } = await import('@aztec/aztec.js');
      const { getEcdsaKAccount } = await import('@aztec/accounts/ecdsa/ecdsa_k');

      const pxe = await createPXEClient(aztecState.pxeUrl);

      const signingPrivateKey = Buffer.from(hexToBytes(derivedKeys.signingKey));
      const encryptionSecretKey = Fr.fromBuffer(Buffer.from(hexToBytes(derivedKeys.encryptionKey)));

      const accountManager = await getEcdsaKAccount(pxe, encryptionSecretKey, signingPrivateKey);
      const wallet = await accountManager.getWallet();

      log('Creating auth witness for test message...');

      // Create a random message hash to sign
      const testMessageHash = Fr.random();
      log(`Test message hash: ${testMessageHash.toString()}`);

      // Create auth witness (this uses the ECDSA signing key)
      const authWitness = await wallet.createAuthWit(testMessageHash);

      log(`Auth witness created!`);
      log(`Witness values: ${authWitness.witness.slice(0, 3).map(w => w.toString().slice(0, 10)).join(', ')}...`);

      log('✓ Successfully signed with derived ECDSA key on Aztec!');

    } catch (error: any) {
      log(`Error: ${error.message}`);
      console.error(error);
    }
  };

  // Clear logs
  const clearLogs = () => setLogs([]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-mono mb-2">[test] MetaMask → Aztec ECDSA Wallet</h1>
        <p className="text-gray-500 text-sm mb-8">
          Derive Aztec ECDSA account from MetaMask signature
        </p>

        {/* PXE URL Config */}
        <div className="border border-[#1a1a1a] p-4 mb-4">
          <p className="text-xs text-gray-500 mb-2">Aztec PXE URL</p>
          <input
            type="text"
            value={aztecState.pxeUrl}
            onChange={(e) => setAztecState(prev => ({ ...prev, pxeUrl: e.target.value }))}
            className="w-full bg-[#111] border border-[#222] px-3 py-2 text-sm font-mono"
            placeholder="http://localhost:8080"
          />
        </div>

        {/* Steps */}
        <div className="space-y-4 mb-8">
          {/* Step 1 */}
          <div className="border border-[#1a1a1a] p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500">Step 1</p>
                <p className="font-mono">Connect MetaMask</p>
                {evmAddress && (
                  <p className="text-sm text-green-500 font-mono mt-1">✓ {evmAddress}</p>
                )}
              </div>
              <button
                onClick={connectMetaMask}
                disabled={!!evmAddress}
                className="px-4 py-2 border border-gray-700 font-mono text-sm hover:border-white disabled:opacity-50"
              >
                {evmAddress ? 'connected' : 'connect'}
              </button>
            </div>
          </div>

          {/* Step 2 */}
          <div className="border border-[#1a1a1a] p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500">Step 2</p>
                <p className="font-mono">Sign & Derive Keys</p>
                {derivedKeys && (
                  <p className="text-sm text-green-500 font-mono mt-1">✓ Keys derived</p>
                )}
              </div>
              <button
                onClick={signAndDeriveKeys}
                disabled={!evmAddress || !!derivedKeys}
                className="px-4 py-2 border border-gray-700 font-mono text-sm hover:border-white disabled:opacity-50"
              >
                sign
              </button>
            </div>
          </div>

          {/* Step 3 */}
          <div className="border border-[#1a1a1a] p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500">Step 3</p>
                <p className="font-mono">Connect to Aztec PXE</p>
                {aztecState.connected && (
                  <p className="text-sm text-green-500 font-mono mt-1">✓ Connected</p>
                )}
                {aztecState.address && (
                  <p className="text-xs text-blue-400 font-mono mt-1">
                    Address: {aztecState.address.slice(0, 20)}...
                  </p>
                )}
              </div>
              <button
                onClick={connectToAztec}
                disabled={!derivedKeys || aztecState.connected}
                className="px-4 py-2 border border-gray-700 font-mono text-sm hover:border-white disabled:opacity-50"
              >
                connect
              </button>
            </div>
          </div>

          {/* Step 4 */}
          <div className="border border-[#1a1a1a] p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500">Step 4</p>
                <p className="font-mono">Deploy Account Contract</p>
                {aztecState.accountDeployed && (
                  <p className="text-sm text-green-500 font-mono mt-1">✓ Deployed</p>
                )}
              </div>
              <button
                onClick={deployAccount}
                disabled={!aztecState.connected || aztecState.accountDeployed}
                className="px-4 py-2 border border-gray-700 font-mono text-sm hover:border-white disabled:opacity-50"
              >
                deploy
              </button>
            </div>
          </div>

          {/* Step 5 */}
          <div className="border border-[#1a1a1a] p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500">Step 5</p>
                <p className="font-mono">Sign Test Message</p>
                <p className="text-xs text-gray-600 mt-1">
                  Creates an auth witness using the derived ECDSA key
                </p>
              </div>
              <button
                onClick={signTestMessage}
                disabled={!aztecState.accountDeployed}
                className="px-4 py-2 border border-gray-700 font-mono text-sm hover:border-white disabled:opacity-50"
              >
                sign
              </button>
            </div>
          </div>
        </div>

        {/* Derived Keys Display */}
        {derivedKeys && (
          <div className="border border-[#1a1a1a] p-4 mb-4">
            <p className="text-xs text-gray-500 mb-2">Derived Keys</p>
            <div className="font-mono text-xs space-y-1">
              <p><span className="text-gray-500">signing (secp256k1):</span> <span className="text-green-500">{derivedKeys.signingKey}</span></p>
              <p><span className="text-gray-500">encryption:</span> <span className="text-purple-500">{derivedKeys.encryptionKey}</span></p>
              {derivedKeys.aztecAddress && (
                <p><span className="text-gray-500">aztec address:</span> <span className="text-blue-400">{derivedKeys.aztecAddress}</span></p>
              )}
            </div>
          </div>
        )}

        {/* Logs */}
        <div className="border border-[#1a1a1a] p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-500">Logs</p>
            <button onClick={clearLogs} className="text-xs text-gray-600 hover:text-white font-mono">
              [clear]
            </button>
          </div>
          <div className="font-mono text-xs space-y-1 max-h-64 overflow-y-auto bg-[#050505] p-2">
            {logs.length === 0 ? (
              <p className="text-gray-600">No logs yet...</p>
            ) : (
              logs.map((log, i) => (
                <p key={i} className="text-gray-400">{log}</p>
              ))
            )}
          </div>
        </div>

        {/* Info */}
        <div className="mt-8 p-4 border border-[#1a1a1a] text-xs text-gray-600 font-mono">
          <p className="text-gray-400 mb-2">[requirements]</p>
          <ul className="list-disc list-inside space-y-1">
            <li>MetaMask installed</li>
            <li>Aztec Sandbox running (aztec start --sandbox)</li>
            <li>PXE accessible at the URL above</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
