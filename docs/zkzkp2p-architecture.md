# zkzkp2p Architecture

## Problem
zkp2p liquidity providers have no privacy - deposit/withdrawal activity is public on-chain, exposing funding sources and transaction patterns.

## Solution
Use Aztec as a privacy layer. User shields Base USDC → Aztec (private) → bridges back to Base via fresh address → creates zkp2p deposit. Train Protocol handles atomic swaps.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         zkzkp2p Frontend (Serverless SPA)               │
├─────────────────────────────────────────────────────────────────────────┤
│  MetaMask (wagmi)  │  Azguard (Aztec)  │  Train  │  @zkp2p/offramp-sdk │
└─────────────────────────────────────────────────────────────────────────┘
         │                   │               │                │
         ▼                   ▼               ▼                ▼
    ┌─────────┐        ┌─────────┐    ┌───────────┐   ┌───────────────┐
    │  Base   │◄──────►│  Aztec  │    │   Train   │   │ zkp2p Escrow  │
    │  USDC   │        │ Private │    │  Contracts│   │ (Base)        │
    └─────────┘        └─────────┘    └───────────┘   └───────────────┘
```

### Dual Wallet Approach

Users connect **two wallets**:
1. **MetaMask** (or any EVM wallet) - for Base chain operations
2. **Azguard** (Aztec browser extension) - for Aztec private operations

Benefits:
- Azguard handles PXE, keys, contract registration
- Standard pattern for Aztec dApps
- No custom key derivation needed
- Wallet adapter pattern allows swapping implementations

---

## Core Dependencies

| Package | Purpose |
|---------|---------|
| `wagmi` + `viem` | Base chain wallet (MetaMask) |
| `@azguardwallet/client` | Aztec wallet (browser extension) |
| `@aztec/aztec.js` | Aztec SDK for contract interactions |
| `@zkp2p/offramp-sdk` | Create deposits, query positions |
| Train Protocol | HTLC atomic swaps (Aztec ↔ EVM) |
| `zustand` | State management (dual wallet state) |

---

## User Flows

### 1. Shield (Base → Aztec)
```
User has Base USDC → Clicks "Shield" → Train atomic swap → Private USDC on Aztec
```
**Steps:**
1. Connect MetaMask
2. User locks USDC on Base (Train ERC20 contract)
3. Filler locks on Aztec (Train contract)
4. User redeems on Aztec (gets private balance)
5. Filler redeems on Base

### 2. Deposit to zkp2p (Aztec → Base)
```
User has Aztec private balance → Clicks "Deposit" → Train swap → zkp2p deposit created
```
**Steps:**
1. User locks on Aztec (Train contract, `lock_src`)
2. Filler locks on Base (Train ERC20)
3. User redeems on Base → receives USDC at fresh address
4. Frontend calls `OfframpClient.createDeposit()` with zkp2p params
5. Filler redeems on Aztec
6. Deposit live on zkp2p

### 3. Manage Positions
- Query deposits via `client.getDeposits()`
- Signal/fulfill intents
- Withdraw back to Base
- Re-shield if desired

---

## Orchestration State Machine

Frontend tracks swap state in localStorage, chain is source of truth for recovery:

```
SHIELD_FLOW:
  IDLE → BASE_LOCKED → AZTEC_LOCKED → AZTEC_REDEEMED → COMPLETE

DEPOSIT_FLOW:
  IDLE → AZTEC_LOCKED → BASE_LOCKED → BASE_REDEEMED → ZKP2P_DEPOSITED → COMPLETE
```

On page load, check chain state to resume interrupted flows.

---

## Data Fetching & Caching Strategy

**Problem:** Aztec private balances require Azguard wallet to decrypt notes (slow, ~5-30s). Page loads show 0 balance until fetch completes.

**Solution:** Cache + parallel fetch with optimistic display.

```
┌─────────────────────────────────────────────────────────┐
│  Page Load                                              │
│  ├─ 1. Show cached balance from localStorage (instant) │
│  └─ 2. Fetch fresh balances in background (parallel)   │
│       ├─ Base USDC      → direct RPC (fast)            │
│       ├─ Aztec private  → Azguard wallet (slow)        │
│       └─ Aztec public   → Azguard wallet (slow)        │
│  3. Update display as each resolves                    │
│  4. Cache new values to localStorage                   │
└─────────────────────────────────────────────────────────┘
```

| Aspect | Implementation |
|--------|----------------|
| Cache key | `zkzkp2p-balance-cache` in localStorage |
| Parallel fetch | All 3 balances via `Promise.all()` |
| Graceful failures | Each balance fails independently with try/catch |
| Manual refresh | User can click ↻ to force refresh |
| Visual feedback | Spinning icon indicates fetch in progress |

**Limitation:** Private balance *must* go through Azguard - only the wallet can decrypt private notes. No bypass possible.

---

## Gas Sponsorship

| Chain | Strategy |
|-------|----------|
| Aztec | SponsoredFPC (fee paymaster) - already works |
| Base | Paymaster or funded fresh address (TBD, like zkp2p does) |

---

## File Structure

```
zkzkp2p/
├── docs/
│   ├── zkzkp2p-architecture.md  (this file)
│   ├── zkzkp2p-onepager.md
│   └── archive-direct-htlc-spec.md
└── frontend/
    ├── src/
    │   ├── components/     # UI components
    │   ├── hooks/          # useShield, useDeposit, useAztec
    │   ├── lib/            # train integration, zkp2p client
    │   ├── state/          # flow state machine
    │   └── pages/          # main app routes
    └── package.json

train-contracts/  (EXTERNAL - adjacent repo)
└── chains/aztec/scripts/zkp2p-e2e.ts  (reference test)
```

---

## Implementation Phases

### Phase 1: E2E Validation ✓
- [x] Write `zkp2p-e2e.ts` proving Train atomic swap works
- [ ] Run test with sandbox

### Phase 2: Frontend Foundation
- [ ] Next.js + wagmi setup
- [ ] Aztec.js browser integration
- [ ] Basic wallet connection (MetaMask → derived Aztec account)
- [ ] Balance display (Base + Aztec)

### Phase 3: Shield Flow
- [ ] Train SDK integration (or direct contract calls)
- [ ] Shield UI + state machine
- [ ] Filler integration (manual initially, then automated)

### Phase 4: Deposit Flow
- [ ] `@zkp2p/offramp-sdk` integration
- [ ] Deposit creation after bridge
- [ ] Position management UI

### Phase 5: Production Hardening
- [ ] Recovery flows (resume interrupted swaps)
- [ ] Error handling
- [ ] Gas optimization

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Bridge | Train Protocol | Working HTLC, maintained externally |
| zkp2p | `@zkp2p/offramp-sdk` | RPC-first, React hooks, official |
| Frontend | Serverless SPA | No backend, chain = source of truth |
| State | Zustand + localStorage | Dual wallet state, recoverable |
| EVM Wallet | MetaMask via wagmi | Standard, EIP-6963 discovery |
| Aztec Wallet | Azguard extension | Handles PXE/keys, standard for Aztec |
