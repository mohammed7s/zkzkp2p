# MetaMask-Native Aztec Integration Strategy

> **Status**: Research & Planning
> **Goal**: Enable users to control Aztec private accounts using only MetaMask
> **Author**: zkzkp2p team
> **Last Updated**: 2025-12-31

---

## Executive Summary

We want zkzkp2p users to have a single-wallet experience: connect MetaMask once, and interact with both EVM and Aztec seamlessly. No additional wallet extensions, no new key management burden.

This document outlines how to achieve this using:
1. **Client-side proving** (browser PXE)
2. **MetaMask for transaction signing** (ECDSA account contracts)
3. **Dumb RPC relay** (no secrets on server)

---

## The Goal

```
User Experience:
┌─────────────────────────────────────────────────────────┐
│  1. User clicks "Connect Wallet"                        │
│  2. MetaMask popup appears                              │
│  3. User signs one message (key derivation)             │
│  4. Done - user can now do private transactions         │
│                                                         │
│  For each transaction:                                  │
│  - Proof generated in browser (client-side)             │
│  - MetaMask signs the transaction                       │
│  - RPC just relays to Aztec network                     │
└─────────────────────────────────────────────────────────┘
```

**Trust Model**: Fully trustless. All secrets stay in browser. RPC server sees nothing sensitive.

---

## The Challenge

### Aztec Requires Three Key Types

| Key | Purpose | Curve | Where Used |
|-----|---------|-------|------------|
| **Signing Key** | Authorize transactions | secp256k1 (ECDSA) | Account contract |
| **Viewing Key** | Decrypt incoming notes | Grumpkin (Fr) | PXE note discovery |
| **Nullifier Key** | Spend notes (derive nullifiers) | Grumpkin (Fr) | PXE nullifier computation |

### The Problem

- Aztec SDK (`@aztec/aztec.js`) was historically Node.js focused
- Browser bundles require careful polyfill configuration
- Key derivation must produce valid Grumpkin field elements

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            BROWSER                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐     ┌─────────────────────────────────────────┐  │
│  │   MetaMask   │────▶│          zkzkp2p Client                 │  │
│  │              │     │                                         │  │
│  │  • Holds     │     │  1. Key Derivation (one-time):          │  │
│  │    ECDSA     │     │     sig = MM.personal_sign(message)     │  │
│  │    private   │     │     viewingKey = derive(sig, "viewing") │  │
│  │    key       │     │     nullifierKey = derive(sig, "null")  │  │
│  │              │     │                                         │  │
│  │  • Signs     │     │  2. Browser PXE:                        │  │
│  │    tx auth   │     │     • Manages notes (IndexedDB)         │  │
│  │              │     │     • Simulates execution               │  │
│  └──────────────┘     │     • Generates ZK proofs (bb.js WASM)  │  │
│         │             │                                         │  │
│         │             │  3. Transaction Flow:                   │  │
│         │             │     • PXE prepares tx, gets messageHash │  │
│         ▼             │     • MM signs messageHash              │  │
│  ┌──────────────┐     │     • Package proof + signature         │  │
│  │ personal_sign│     │     • Send to RPC                       │  │
│  │ (tx auth)    │     │                                         │  │
│  └──────────────┘     └─────────────────────────────────────────┘  │
│                                    │                                │
└────────────────────────────────────┼────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          RPC SERVER                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   DUMB RELAY - No secrets, no proving, no key access                │
│                                                                     │
│   • Receives packaged transaction (proof + signature)               │
│   • Forwards to Aztec node                                          │
│   • Returns result to browser                                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         AZTEC NETWORK                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ECDSA Account Contract:                                           │
│   • Verifies MetaMask signature matches registered pubkey           │
│   • ZK proof verified                                               │
│   • State updated                                                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Why This Works

### 1. Aztec Supports ECDSA Account Contracts

Aztec has `EcdsaKAccountContract` which uses secp256k1 - the same curve as Ethereum/MetaMask.

**Key file**: `@aztec/accounts/src/ecdsa/ecdsa_k/account_contract.ts`

```typescript
class EcdsaKAuthWitnessProvider implements AuthWitnessProvider {
  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    const ecdsa = new Ecdsa();
    const signature = await ecdsa.constructSignature(messageHash.toBuffer(), this.signingPrivateKey);
    return new AuthWitness(messageHash, [...signature.r, ...signature.s]);
  }
}
```

### 2. Signing Format is MetaMask-Compatible

Aztec uses the standard Ethereum `personal_sign` prefix:

**Key file**: `@aztec/foundation/src/crypto/secp256k1-signer/utils.ts`

```typescript
const ETH_SIGN_PREFIX = '\x19Ethereum Signed Message:\n32';

export function makeEthSignDigest(message: Buffer32): Buffer32 {
  const prefix = Buffer.from(ETH_SIGN_PREFIX);
  return Buffer32.fromBuffer(keccak256(Buffer.concat([prefix, message.buffer])));
}
```

This means MetaMask's `personal_sign` can directly sign Aztec transaction authorization!

### 3. PXE Runs in Browser (WASM)

Aztec's bb.js compiles Barretenberg to WASM, enabling full client-side proving.

**Key packages**:
- `@aztec/bb-prover/client/wasm/bundle` - Bundled protocol contracts
- `@aztec/bb-prover/client/wasm/lazy` - Lazy-load protocol contracts
- `@aztec/kv-store/indexeddb` - Browser storage

---

## Implementation Details

### Key Derivation from MetaMask Signature

```typescript
// One-time setup when user connects
async function deriveAztecKeys(metamaskAddress: string) {
  // 1. User signs derivation message
  const message = `zkzkp2p key derivation v1\nAddress: ${metamaskAddress}`;
  const signature = await window.ethereum.request({
    method: 'personal_sign',
    params: [message, metamaskAddress]
  });

  // 2. Derive Aztec keys from signature
  // Signing key = MetaMask's own key (used via personal_sign for each tx)
  // Viewing key = hash of signature, reduced to Grumpkin Fr
  // Nullifier key = hash of signature + salt, reduced to Grumpkin Fr

  const viewingKey = deriveGrumpkinScalar(signature, "viewing");
  const nullifierKey = deriveGrumpkinScalar(signature, "nullifier");

  // 3. Store locally (encrypted or in memory)
  return { viewingKey, nullifierKey };
}

function deriveGrumpkinScalar(signature: string, domain: string): Fr {
  // Hash signature with domain separator
  const hash = keccak256(concat([signature, domain]));
  // Reduce modulo Grumpkin field order to get valid Fr
  return Fr.fromBuffer(hash);
}
```

### Custom AuthWitnessProvider for MetaMask

```typescript
class MetaMaskAuthWitnessProvider implements AuthWitnessProvider {
  constructor(private userAddress: string) {}

  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    // Instead of signing internally, call MetaMask
    const signature = await window.ethereum.request({
      method: 'personal_sign',
      params: [messageHash.toBuffer(), this.userAddress]
    });

    // Parse signature into r, s components
    const { r, s } = parseEthereumSignature(signature);

    return new AuthWitness(messageHash, [...r, ...s]);
  }
}
```

### Browser PXE Setup

**Required webpack config** (from Aztec boxes):

```javascript
// webpack.config.js
{
  plugins: [
    new webpack.ProvidePlugin({ Buffer: ['buffer', 'Buffer'] }),
  ],
  resolve: {
    fallback: {
      buffer: require.resolve('buffer/'),
      util: require.resolve('util/'),
      assert: require.resolve('assert/'),
      stream: require.resolve('stream-browserify'),
      crypto: false,
      fs: false,
      path: false,
      os: false,
    },
  },
  devServer: {
    headers: {
      // Required for SharedArrayBuffer (multithreaded WASM)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
}
```

**Required dependencies**:
```json
{
  "dependencies": {
    "@aztec/aztec.js": "latest",
    "@aztec/accounts": "latest",
    "@aztec/pxe": "latest",
    "@aztec/kv-store": "latest"
  },
  "devDependencies": {
    "buffer": "^6.0.3",
    "util": "^0.12.5",
    "assert": "^2.1.0",
    "stream-browserify": "^3.0.0"
  }
}
```

### Creating In-Browser PXE

```typescript
import { createAztecNodeClient } from '@aztec/aztec.js';
import { createPXEService } from '@aztec/pxe/client/lazy';
import { getPXEServiceConfig } from '@aztec/pxe/config';

async function initBrowserPXE(nodeUrl: string) {
  // Connect to remote Aztec node
  const aztecNode = await createAztecNodeClient(nodeUrl);

  // Create PXE service in browser
  const config = getPXEServiceConfig();
  config.l1Contracts = await aztecNode.getL1ContractAddresses();
  config.proverEnabled = true; // Enable client-side proving

  const pxe = await createPXEService(aztecNode, config, {
    useLogSuffix: true,
  });

  return pxe;
}
```

---

## Prior Art & References

### Facet Private Demo
- **Repo**: https://github.com/0xFacet/facet-private-demo
- **Approach**: Server-side proving, but ECDSA verification in circuit prevents forgery
- **Key insight**: Backend can see data but cannot spend funds without valid MetaMask signature

### Nullmask
- **Location**: `/home/ubuntu/Dropbox/WEB/nullmask/nullmask/`
- **Approach**: Full RPC adapter pattern with key derivation from wallet signature
- **Key insight**: Uses Noir + Barretenberg (same stack as Aztec)
- **Relevant files**:
  - `web/packages/rpc-handler/` - RPC interception
  - `web/packages/noir/` - Proof generation
  - `circuits/` - Noir circuits

### Aztec Browser Examples
- **Location**: `aztec-packages/boxes/`
- **Vanilla box**: Full in-browser PXE with IndexedDB storage
- **React box**: Remote PXE client example
- **Vite box**: Modern bundler config

### Aztec Documentation
- Wallet Architecture: https://docs.aztec.network/aztec/concepts/wallets/architecture
- PXE Concepts: https://docs.aztec.network/developers/docs/concepts/pxe
- Keys: https://docs.aztec.network/developers/docs/concepts/accounts/keys

### Key Source Files (Aztec)
- ECDSA Account: `@aztec/accounts/src/ecdsa/ecdsa_k/account_contract.ts`
- Secp256k1 Signer: `@aztec/foundation/src/crypto/secp256k1-signer/`
- Browser WASM: `barretenberg/ts/src/barretenberg_wasm/fetch_code/browser/`
- PXE Client Creation: `yarn-project/pxe/src/entrypoints/client/`

---

## Open Questions

### 1. ECDSA Account Deployment
- How to deploy the account contract initially?
- Can it be deployed with the first transaction (counterfactual)?
- Registration of MetaMask public key on-chain

### 2. Key Storage
- Where to store derived viewing/nullifier keys?
- Options: localStorage (encrypted), IndexedDB, session-only
- Re-derivation on each session vs persistent storage

### 3. Note Discovery
- How does browser PXE discover user's notes without full chain scan?
- Indexer service for note discovery?
- Privacy implications of note discovery service

### 4. Gas/Fee Payment
- Who pays gas for Aztec transactions?
- Fee abstraction options
- Relayer model for gasless UX

---

## Implementation Phases

### Phase 1: Validate Browser PXE
- [ ] Set up Next.js/Vite with correct polyfills
- [ ] Initialize browser PXE connected to devnet
- [ ] Verify proof generation works in browser
- [ ] Measure proving times

### Phase 2: MetaMask Key Derivation
- [ ] Implement key derivation from signature
- [ ] Verify derived keys produce valid Grumpkin scalars
- [ ] Test account creation with derived keys

### Phase 3: Custom AuthWitnessProvider
- [ ] Create MetaMaskAuthWitnessProvider
- [ ] Integrate with Aztec account system
- [ ] Test transaction signing via MetaMask popup

### Phase 4: Full Integration
- [ ] Deploy ECDSA account contract
- [ ] End-to-end private transfer test
- [ ] RPC relay setup
- [ ] Production hardening

---

## Appendix: Alternative Approaches Considered

### Server-Side Proving (Facet/Nullmask style)
- **Pros**: Faster proving, simpler browser setup
- **Cons**: Backend sees user data (though can't spend)
- **Verdict**: Viable fallback if browser proving too slow

### Azguard Extension
- **Pros**: Works today, production-ready
- **Cons**: Requires separate extension, separate identity
- **Verdict**: Good short-term option, not ideal UX

### Nyx Wallet
- **Pros**: Passkey-based, good UX
- **Cons**: Not MetaMask-native, separate identity system
- **Verdict**: Different product direction

---

## Contact

For questions about this strategy, reach out to the zkzkp2p team.
