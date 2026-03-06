# zkzkp2p Pre-Alpha Plan

## Goal
Test the full offramp/onramp flow end-to-end with a mocked bridge layer,
so we can validate burner derivation, paymaster, zkp2p deposits, and the
overall UX before NEAR Intents ships their Aztec connector.

## Target Architecture

### Offramp (Aztec -> Fiat)
```
Aztec USDC -> NEAR Intents -> Base ephemeral addr -> zkp2p deposit -> fiat
```

### Onramp (Fiat -> Aztec)
```
Fiat -> zkp2p -> Base intermediate addr -> NEAR Intents -> Aztec USDC
```

Our app orchestrates both legs. NEAR Intents replaces Substance Bridge
as the cross-chain layer. zkp2p stays as the fiat on/offramp.

## Pre-Alpha: Mocked Bridge

NEAR Intents Aztec connector is ~weeks out. We mock the bridge step so
everything else can be tested now.

### What's mocked
- The Aztec <-> Base bridge (currently Substance, will be NEAR Intents)
- A "solver" manually sends USDC to the burner address on Base

### What's real (testable now)
- Burner key derivation (master key + timestamp nonce)
- Smart account address generation
- Coinbase paymaster (gasless txs from burner)
- zkp2p deposit creation via offramp-sdk
- zkp2p onramp via signalIntent / redirect
- Flow persistence and recovery (zustand store)
- Aztec EmbeddedWallet + MetaMask key derivation

### Mock flow (offramp)
1. User enters amount, payment method, payment tag
2. App derives burner -> gets smart account address
3. App displays address and polls for USDC balance (instead of bridge)
4. Operator/tester manually sends USDC to that address
5. App detects balance -> proceeds to zkp2p deposit (gasless)
6. Taker picks up intent -> pays fiat

### Mock flow (onramp)
1. App derives burner -> gets smart account address
2. zkp2p onramp delivers USDC to that address
3. App detects balance -> displays "bridge to Aztec" step (mocked)
4. For now: USDC sits on Base. When NEAR ready: auto-bridge to Aztec

## NEAR Intents Integration (when ready)

### API: 1Click at https://1click.chaindefuser.com/v0/

Endpoints:
- GET  /v0/tokens          - list supported tokens (cache)
- POST /v0/quote           - get quote + deposit address (~10 min valid)
- POST /v0/deposit/submit  - notify of deposit tx (speeds processing)
- GET  /v0/status          - poll until SUCCESS/FAILED/REFUNDED

### Integration module: lib/nearIntents/index.ts

```typescript
interface NearIntentsSwap {
  getQuote(origin: AssetId, dest: AssetId, amount: string, recipient: string): Promise<Quote>
  submitDeposit(txHash: string, depositAddress: string): Promise<void>
  pollStatus(depositAddress: string): Promise<SwapStatus>
}
```

### Swap: replace mock with real bridge
- Offramp: quote Aztec USDC -> Base USDC, deposit on Aztec, poll until Base addr funded
- Onramp: quote Base USDC -> Aztec USDC, deposit on Base, poll until Aztec addr funded

The only code that changes is the bridge function. Everything else
(burner, paymaster, zkp2p, UI) stays identical.

## Key Addresses (devnet)

- Aztec node: https://v4-devnet-2.aztec-labs.com
- Aztec token: 0x276277413688cda0bac9133d2c55974bc8d735c3336ddccdeb16744e3d9dc600
- Base USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- Sponsored FPC: 0x1586f476995be97f07ebd415340a14be48dc28c6c661cc6bdddb80ae790caa4e

## Branches

- `metamask` - current working branch (MetaMask + COOP/COEP headers)
- `privy` - stashed Privy work (blocked by bb.js COOP conflict)
- `near-intents` - (to create) mocked bridge + NEAR Intents interface

## Open Questions

- NEAR Intents API key: need to register at their partners portal
- Does NEAR Intents support Aztec devnet tokens or only mainnet?
- Exact asset IDs for Aztec USDC in their token list (once connector ships)
- Privy: blocked until bb.js fixes non-threaded WASM fallback (no SharedArrayBuffer without COOP)
