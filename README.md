# zkzkp2p

Private fiat offramp using Aztec for privacy and zkp2p for peer-to-peer settlements.

## Architecture

```
User (Aztec private balance)
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  1. Derive Burner Key (MetaMask signature)          │
│  2. Bridge: Aztec → Base burner via bridge layer    │
│  3. Create zkp2p Deposit (gasless via Paymaster)    │
└─────────────────────────────────────────────────────┘
    │
    ▼
zkp2p Deposit (owned by fresh burner address)
```

## Current Integration Modes

- `NEXT_PUBLIC_BRIDGE_ONLY_MODE=true`: local bridge test mode. The flow stops after the burner receives Base USDC.
- `NEXT_PUBLIC_BRIDGE_ONLY_MODE=false`: continue into the sponsored zkp2p deposit flow after burner funding.
- `NEXT_PUBLIC_BASE_NETWORK=mainnet|sepolia`: switches Base chain defaults, RPC, explorer, and default USDC address.

The bridge flow now lives entirely in `frontend/src/lib/nearIntents`. There is no separate local solver service to run. For local development, the current pre-alpha bridge path can still auto-fund the burner and auto-fill Aztec using `NEXT_PUBLIC_*` bridge keys. Those values are embedded in the browser bundle, so this mode is for local testing only and must not be treated as a deployable production setup.

## Burner Address Derivation

Each deposit uses a **fresh burner address** for privacy. The burner key is derived using a two-layer system that allows recovery even if localStorage is lost.

### Two-Layer Derivation

```
Layer 1: Master Key (re-derivable anytime)
┌─────────────────────────────────────────────────────┐
│  message = "zkzkp2p master key v2 for 0x..."        │
│  signature = MetaMask.sign(message)                 │
│  masterKey = keccak256(signature)                   │
└─────────────────────────────────────────────────────┘

Layer 2: Burner Key (per-deposit, uses timestamp nonce)
┌─────────────────────────────────────────────────────┐
│  nonce = floor(Date.now() / 60000)  // minutes      │
│  burnerKey = keccak256(masterKey + nonce)           │
│  burnerAddress = derive(burnerKey)                  │
└─────────────────────────────────────────────────────┘
```

### Why This Design?

| Requirement | Solution |
|-------------|----------|
| Fresh address per deposit | Timestamp nonce changes every minute |
| Recoverable if tab crashes | Nonce saved in localStorage with flow state |
| Recoverable if localStorage lost | Brute-force ~43k nonces/month (sub-second) |
| No server dependency | All derivation happens client-side |
| Cross-device doesn't matter | Recovery is per-device (flow state is local) |

### Recovery Scenarios

| Scenario | Recovery Method |
|----------|-----------------|
| Tab crashes, localStorage intact | Read nonce from flowStore → re-sign master → derive |
| localStorage lost, know burner address | Re-sign master → brute-force nonces → find match |
| localStorage lost, don't know address | Check basescan for recent txs to smart account factory |

### Emergency Recovery Code

If a user loses localStorage but knows their burner address:

```typescript
import { emergencyRecoverBurner } from '@/lib/burner';

// This prompts for one MetaMask signature, then brute-forces locally
const result = await emergencyRecoverBurner(
  walletClient,
  userAddress,        // User's main wallet
  lostBurnerAddress,  // The burner they're trying to recover
  30                  // Days to search back (default 30)
);

if (result) {
  console.log('Recovered!', result.privateKey, result.nonce);
} else {
  console.log('Not found in date range');
}
```

## Gasless Transactions (Paymaster)

The burner smart account uses **Coinbase Paymaster** for gas sponsorship:

- User never needs ETH on the burner
- No dust left behind
- Paymaster pays for: smart account deployment, USDC approve, zkp2p deposit

### Setup

1. Get a Paymaster endpoint from [Coinbase Developer Platform](https://portal.cdp.coinbase.com/)
2. Add to `.env.local`:
   ```
   NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL=https://api.developer.coinbase.com/rpc/v1/base-sepolia/<API_KEY>
   ```
3. Configure gas policy in the dashboard (recommended: $50 global, $10 per user)

## Local Bridge Setup

For local end-to-end testing, the frontend can use bridge-side accounts directly:

```bash
NEXT_PUBLIC_SOLVER_AZTEC_ADDRESS=
NEXT_PUBLIC_AZTEC_SENDER_ADDRESSES=
NEXT_PUBLIC_BRIDGE_ONLY_MODE=true
```

If you also set the bridge private keys in `frontend/.env.local`, the browser app will auto-send Base USDC and auto-fill Aztec during the bridge flow. That is convenient for local development and unsafe for any shared or production deployment, because `NEXT_PUBLIC_*` env vars are exposed client-side.

## TODO

- [x] Make Base accounts fresh each time per deposit
- [ ] Update to use Holonym USDC contracts integration
