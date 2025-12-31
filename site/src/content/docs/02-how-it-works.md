# How It Works

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        zkzkp2p                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Base                       Aztec                          │
│   ┌─────────────┐            ┌─────────────┐               │
│   │    USDC     │            │   Private   │               │
│   │             │            │   Balance   │               │
│   └──────┬──────┘            └──────┬──────┘               │
│          │                          │                       │
│          ▼                          ▼                       │
│   ┌─────────────┐            ┌─────────────┐               │
│   │ Train HTLC  │◄──────────►│ Train HTLC  │               │
│   │             │   atomic   │             │               │
│   └──────┬──────┘            └─────────────┘               │
│          │                                                  │
│          ▼                                                  │
│   ┌─────────────┐                                          │
│   │   Fresh     │                                          │
│   │  Address    │──────────► zkp2p Deposit                 │
│   └─────────────┘                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Fund Private Wallet (Base → Aztec)

Move USDC from Base to your private Aztec balance.

**What happens:**

1. A fresh Aztec address is generated locally in your browser
2. USDC is locked in Train HTLC on Base with:
   - Amount
   - Hashlock: `hash(secret)` — secret known only to your browser
   - Recipient: the fresh Aztec address
3. Solver detects the lock, verifies terms
4. Solver locks equivalent USDC in Train HTLC on Aztec to your fresh address
5. Your browser redeems on Aztec, revealing the secret
6. Solver redeems on Base using the revealed secret

**Result:** Private USDC on Aztec. The fresh address has no history linking to your Base wallet.

## Create zkp2p Deposit (Aztec → zkp2p)

Create a zkp2p deposit from your private balance.

**What happens:**

1. A fresh Base address is generated locally in your browser
2. USDC is locked in Train HTLC on Aztec with:
   - Amount
   - Hashlock: `hash(secret)`
   - Recipient: the fresh Base address
3. Solver detects the lock, verifies terms
4. Solver locks equivalent USDC in Train HTLC on Base to the fresh address
5. Fresh address redeems on Base, revealing the secret
6. Solver redeems on Aztec using the revealed secret
7. Fresh address creates zkp2p deposit

**Result:** zkp2p deposit from an address with no transaction history. The Aztec side is encrypted — observers cannot trace it to you.

## How Train/HTLC Works

Train Protocol uses Hash Time-Locked Contracts for trustless atomic swaps.

**The Lock:**

| Field | Value |
|-------|-------|
| Amount | 100 USDC |
| Hashlock | `hash(secret)` |
| Timelock | 2 hours |
| Recipient | solver |

**The Swap:**

1. You lock with hash(secret)     — funds locked
2. Solver locks with same hash    — counter-liquidity locked
3. You redeem, revealing secret   — you get solver's funds
4. Solver uses secret to redeem   — solver gets your funds


**Safety:** Your lock expires in 2 hours, solver's in 1 hour. You always have time to claim before the solver can refund. If the swap doesn't complete, both sides get their funds back after timeout.

## How the Wallet Works

zkzkp2p uses MetaMask as the single source of identity. When you connect, you sign a message that derives your Aztec private keys. All proving happens in your browser — the server never sees your keys.

*Currently in development. See [MetaMask Integration Strategy](/docs/metamask-strategy) for details.*
