# Bridge Plan

## Product Flows

### 1. `on_privacy` — Base -> Aztec private balance

User starts on Base with USDC.

1. User sends Base USDC to the solver's Base address.
2. Solver sends Aztec USDC privately to the user's Aztec address.
3. User's Aztec private balance increases by the filled amount.

Production target:
- Replace the hardcoded solver behavior with NEAR Intents / 1Click.
- Keep the swap schema and flow structure compatible with future replacement.

Pre-alpha implementation target:
- No separate solver service.
- App uses a single hardcoded solver identity from env.
- Solver fill is simulated locally by sending from the configured solver wallet.

### 2. `deposit_to_peer` — Aztec private balance -> burner Base account -> peer.xyz deposit

User starts with Aztec private USDC.

1. User derives an ephemeral burner / smart account on Base.
2. User sends Aztec private USDC to the solver's Aztec address.
3. Solver sends Base USDC 1:1 to the burner's Base address.
4. Burner account uses sponsored gas to create a deposit on peer.xyz.

Production target:
- Step 2/3 replaced by NEAR Intents.
- Burner and peer.xyz deposit logic remain local app behavior.

### 3. `offramp_to_private` — peer.xyz withdrawal -> burner Base account -> Aztec private balance

User wants to buy USDC on peer.xyz and receive it privately on Aztec.

1. User derives a burner Base account.
2. peer.xyz withdrawal settles to that burner.
3. Burner requests bridge back to Aztec private balance.
4. Burner sends Base USDC to solver Base address.
5. Solver sends Aztec private USDC to the user's Aztec address.

Production target:
- Base -> Aztec leg replaced by NEAR Intents when available for Aztec.

## Current State

### Working

- Embedded wallet + MetaMask path is the active path.
- Private balance discovery works once sender addresses are registered.
- `CreateDeposit` already uses the mock solver bridge for Aztec -> Base.
- Burner derivation and sponsored smart account logic already exist.

### Not Yet Aligned

- `PrivateAccount` still uses the older Substance `executeShield()` path for Base -> Aztec.
- The mock bridge currently uses Base mainnet semantics.
- The peer.xyz client is currently hardcoded to Base Sepolia staging.
- End-to-end flow is not yet on one coherent network.

## Rollout

### Step 1 — Base Sepolia bridge-only validation

Goal:
- Prove the burner account flow and hardcoded solver swap mechanics.
- Do not create a real peer.xyz deposit yet.

Scope:
- Move the mock solver bridge to Base Sepolia.
- Make `CreateDeposit` stop after funds arrive at the burner.
- Add an explicit test mode for:
  - derive burner
  - send Aztec private USDC to solver
  - solver sends Base USDC to burner
  - verify burner balance
- Replace `PrivateAccount` Base -> Aztec shield flow with the same mock-solver model:
  - user sends Base USDC to solver Base wallet
  - solver sends Aztec private USDC to user
- Keep all solver identities env-driven and single-solver for now.

Success criteria:
- Base -> Aztec mock fill works with one hardcoded solver.
- Aztec -> burner Base mock fill works with one hardcoded solver.
- Private balance pickup works after solver sends on Aztec.
- Burner receives USDC on Base Sepolia exactly as expected.

### Step 2 — Base mainnet + peer.xyz SDK

Goal:
- Move from bridge-only validation into the real peer.xyz deposit path.

Scope:
- Switch the mock bridge to Base mainnet.
- Align paymaster, burner, token, and peer.xyz SDK to Base mainnet.
- Re-enable the real peer.xyz deposit creation after burner funding.
- Then implement the reverse flow:
  - peer.xyz withdrawal -> burner
  - burner -> solver Base
  - solver -> Aztec private

Success criteria:
- User can fund Aztec privately from Base through the hardcoded solver.
- User can create a live peer.xyz deposit from a burner account.
- User can withdraw to a burner and bridge back to Aztec privately.

## Code Changes Needed

### A. Unify bridge abstraction

- Create one mock bridge abstraction with two directions:
  - Base -> Aztec private
  - Aztec private -> Base burner
- Keep function shapes close to NEAR Intents concepts:
  - quote / recipient / refund / status / submit
- Hide hardcoded solver execution behind that abstraction.

### B. Replace old `PrivateAccount` shield flow

- Remove dependence on Substance `createBridge()` / `executeShield()`.
- Implement Base -> Aztec mock fill using solver env config.
- Reuse sender registration assumptions for solver-originated Aztec notes.

### C. Network alignment

- Step 1: make bridge, burner, token, and paymaster all use Base Sepolia.
- Step 2: make bridge, burner, token, and peer.xyz SDK all use Base mainnet.

### D. Mode gating

- Add a bridge-only test mode that ends after burner funding.
- Add the real peer.xyz deposit step only in Step 2.

### E. Reverse flow

- Add burner withdrawal / buy flow after deposit path is stable.

## Immediate Next Task

Implement Step 1:

1. Convert the mock bridge code to Base Sepolia.
2. Replace `PrivateAccount` shield flow with the same mock-solver pattern.
3. Add a temporary "bridge only" path in `CreateDeposit` that stops after burner funding.
4. Test:
   - Base -> Aztec private
   - Aztec private -> burner Base
