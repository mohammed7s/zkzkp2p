# zkzkp2p: Private Liquidity for zkp2p

> Trustless, privacy-preserving liquidity for zkp2p via Aztec L2

---

## The Problem

**zkp2p has a privacy problem.**

Liquidity providers (makers) on zkp2p deposit funds on Base (an EVM chain). This means:

- Anyone can see their **deposit history**
- Anyone can trace their **funding sources**
- Anyone can link deposits to their **other on-chain activity**
- Exchange wallets, CEX withdrawals, and transaction patterns are **all visible**

For users who value privacy, this is a dealbreaker. They want to provide liquidity without exposing their entire financial history.

---

## The Solution: Aztec as Privacy Infrastructure

**Use Aztec L2 as a privacy layer for zkp2p liquidity.**

Aztec provides encrypted state and private transactions. By moving funds from Aztec to Base, users can:

- Fund zkp2p deposits from a **private source**
- Break the link between their **identity and liquidity**
- Participate in zkp2p **without exposing transaction history**

## How It Works

**zkzkp2p** uses an atomic swap mechanism:

1. **User locks USDC on Aztec** with a hashlock
2. **Filler creates a gated deposit on Base** (dormant until activated)
3. **User reveals secret** to activate the deposit
4. **Filler redeems on Aztec** using the revealed secret

```
AZTEC                              BASE
─────                              ────
User locks
  │
  │ ───(hashes)──────────────▶ Filler creates
  │                            gated deposit
  │                                │
  │ ───(secret)────────────────────▶ User activates
  │                            Deposit ACTIVE
  │ ◀──(secret now public)─────────┘
  ▼
Filler redeems
```

**If anything fails**: Both parties can refund after their respective timelocks expire.

---

## Key Innovation: Hash-Only Privacy

The filler **never learns user's identity**:

| Data | User | Filler | Public |
|------|:----:|:------:|:------:|
| Raw payee ID (e.g. "@revolut_user") | Yes | **No** | No |
| Hash of payee ID | Yes | Yes | Yes |
| HTLC secret (before reveal) | Yes | No | No |

**How?** User computes hashes locally before submitting to Aztec. Filler only copies these hashes to Base - never sees the raw values.

---

## Why It Works

| Property | How |
|----------|-----|
| **Atomic** | HTLC hashlock ensures both sides complete or neither does |
| **Trustless** | Smart contracts on both chains, no intermediaries |
| **Private** | Filler only sees hashes, not raw user details |
| **Safe** | Timelocked refunds protect both parties |

---

## Architecture

```
┌─────────────┐                    ┌─────────────┐
│  AZTEC L2   │                    │   BASE L2   │
│             │                    │             │
│  ┌───────┐  │    Copy hashes     │  ┌───────┐  │
│  │ HTLC  │──┼───────────────────▶│  │ Gated │  │
│  │       │  │   Filler creates   │  │Deposit│  │
│  └───────┘  │                    │  └───────┘  │
│      │      │                    │      │      │
│      │      │   Reveal secret    │      │      │
│      ▼      │◀───────────────────┼──────┘      │
│Filler redeems                    │      ▼      │
│             │                    │   zkp2p     │
└─────────────┘                    └─────────────┘
```

---

## Timeline Example

```
T+0h   User locks on Aztec (8hr timelock)
T+1h   Filler creates gated deposit on Base (4hr timelock)
T+2h   User activates deposit (reveals secret)
T+2h   Filler redeems on Aztec (using now-public secret)

       ✓ User has zkp2p deposit on Base
       ✓ Filler has USDC on Aztec
```

**Failure case**: If user doesn't activate by T+4h, filler can cancel on Base. User refunds on Aztec after T+8h.

---

## Components

| Component | Description |
|-----------|-------------|
| **User** | Wants to provide liquidity on zkp2p privately. Locks funds on Aztec, activates deposit on Base. |
| **Filler** | Provides Base liquidity. Creates gated deposits, redeems on Aztec after user reveals secret. |
| **Aztec HTLC** | Smart contract on Aztec that holds user's funds until secret is revealed or timeout. |
| **Gated Deposit** | Smart contract on Base that creates a dormant zkp2p deposit, activated by secret. |

---

## Based On

Built on [Train Protocol](https://github.com/TrainProtocol/contracts) (MIT), simplified for one-directional Aztec → Base flow.

---

## Contact

[Add contact info here]
