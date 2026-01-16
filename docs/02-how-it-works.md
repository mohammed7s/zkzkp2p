# How zkzkp2p Works

This document explains the technical flows that enable private liquidity provision on zkp2p.

---

## Overview

zkzkp2p uses **Hash Time-Locked Contracts (HTLCs)** to create atomic swaps between Aztec (private) and Base (public). A network of **solvers** provides liquidity on both chains, enabling trustless bridging.

```
┌─────────────────────────────────────────────────────────────────┐
│                        zkzkp2p System                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   User                    Solver                    zkp2p       │
│     │                       │                         │         │
│     │  1. Lock funds        │                         │         │
│     ├──────────────────────►│                         │         │
│     │                       │  2. Counter-lock        │         │
│     │                       │                         │         │
│     │  3. Reveal secret     │                         │         │
│     ├──────────────────────►│                         │         │
│     │                       │  4. Claim               │         │
│     │                       ├────────────────────────►│         │
│     │                       │                         │         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Two Core Flows

### Flow 1: Shield (Base → Aztec)

**Purpose**: Move USDC from Base to a private balance on Aztec.

```
BASE                                 AZTEC
────                                 ─────
User has public USDC
       │
       ▼
[1] User locks on Base
    (Train ERC20 contract)
       │
       │ ─────(hashlock)─────────►  Solver sees lock event
       │                                    │
       │                                    ▼
       │                           [2] Solver locks on Aztec
       │                               (Train contract, lock_dst)
       │                                    │
       │ ◄─────(lock confirmed)────────────┘
       │
       ▼
[3] User redeems on Aztec
    (reveals secret, gets private balance)
       │
       │ ─────(secret revealed)────────────►
       │                                    │
       │                                    ▼
       │                           [4] Solver redeems on Base
       │                               (uses revealed secret)
       │
       ▼
User has PRIVATE USDC on Aztec
```

**Key Point**: The user ends with a *private* balance on Aztec. The solver earns a fee for providing liquidity.

---

### Flow 2: Deposit (Aztec → Base with Fresh Address)

**Purpose**: Create a zkp2p deposit from a fresh, unlinkable Base address.

```
AZTEC                                BASE
─────                                ────
User has private USDC
       │
       ▼
[1] Generate fresh Base address
    (random keys, no history)
       │
       ▼
[2] User locks on Aztec
    (Train contract, lock_src)
       │
       │ ─────(hashlock)─────────────►  Solver sees lock event
       │                                        │
       │                                        ▼
       │                               [3] Solver locks on Base
       │                                   (Train ERC20, to FRESH addr)
       │                                        │
       │ ◄─────(lock confirmed)────────────────┘
       │
       ▼
[4] User redeems on Base
    (from fresh address, reveals secret)
       │
       │                                        │
       │                                        ▼
       │                               [5] Solver redeems on Aztec
       │                                   (uses revealed secret)
       │
       ▼
[6] Fresh address calls zkp2p
    createDeposit()
       │
       ▼
DEPOSIT ACTIVE ON zkp2p
(unlinkable to original wallet)
```

**Key Point**: The fresh Base address has *no connection* to the user's original wallet. Observers see a new address creating a deposit, but cannot trace its funding source.

---

## Fresh Address Privacy

The **fresh address** technique is critical to zkzkp2p's privacy:

### How It Works

1. **Random Key Generation**: For each deposit, generate completely random private keys
2. **No On-Chain History**: The fresh address has never appeared on any blockchain
3. **Atomic Funding**: Solver sends funds directly to the fresh address during the swap
4. **Single Use**: Address is only used for the zkp2p deposit

### Privacy Properties

| Observer | Can See | Cannot See |
|----------|---------|------------|
| Base chain | Fresh address created deposit | Link to user's main wallet |
| Aztec chain | Lock was redeemed | Who redeemed (private) |
| Solver | Both chain events | Link between them |
| zkp2p | New depositor address | Funding source |

### Why Aztec is Essential

On a transparent chain, the solver's transaction would create a visible link:
```
Solver → Fresh Address (visible on Base)
```

But with Aztec:
```
User (private) → Solver (Aztec) → Fresh Address (Base)
       └─────── encrypted, unlinkable ──────┘
```

The solver can see both events, but *they don't know who* is on the Aztec side because Aztec state is encrypted.

---

## The Train Protocol

zkzkp2p uses Train Protocol for atomic swaps. Here's how the HTLC mechanism works:

### HTLC Basics

```
HTLC = Hash Time-Locked Contract

Components:
- hashlock: Hash of a secret (H = hash(S))
- timelock: Deadline for claiming
- sender: Who locked the funds
- receiver: Who can claim with the secret
```

### Lock and Redeem

**Locking (lock_src / lock_dst)**:
```
User generates: secret S, hashlock H = hash(S)
User locks: amount, hashlock H, timelock, receiver
→ Funds held by contract until secret revealed or timeout
```

**Redeeming**:
```
Receiver provides: secret S
Contract verifies: hash(S) == H
If valid: funds released to receiver, secret now public
```

**Refunding (if timeout)**:
```
After timelock expires, original sender can reclaim funds
```

### Reward Mechanism

Solvers earn a reward for providing liquidity:

```
User locks:   100 USDC on Aztec
Solver locks: 110 USDC on Base (100 + 10% reward)
User gets:    100 USDC on Base
Solver gets:  100 USDC on Aztec + 10 USDC reward
```

The reward compensates solvers for:
- Capital lockup during the swap
- Gas costs on both chains
- Liquidity provision risk

---

## Timelocks and Safety

Timelocks ensure atomicity and protect both parties:

```
Timeline:
─────────────────────────────────────────────────────────►
T+0                    T+1hr                    T+2hr
 │                       │                        │
 └─ User locks           └─ Solver timelock       └─ User timelock
    on source               expires                  expires
```

**Safety Rules**:
1. Solver timelock < User timelock (user has more time to claim)
2. User must redeem before solver's timelock expires
3. If user doesn't claim, solver refunds on destination
4. If solver doesn't lock, user refunds on source

### Example Scenario

```
T+0h:   User locks 100 USDC on Aztec (2hr timelock)
T+5m:   Solver locks 110 USDC on Base (1hr timelock)
T+30m:  User redeems on Base (reveals secret)
T+30m:  Solver redeems on Aztec (uses revealed secret)
        ✓ Swap complete

Alternative (user abandons):
T+0h:   User locks on Aztec
T+5m:   Solver locks on Base
T+1h:   User didn't redeem → Solver refunds on Base
T+2h:   User refunds on Aztec
        ✓ Both parties get their funds back
```

---

## The Solver Network

Solvers are independent operators who:
- Monitor both chains for lock events
- Provide counter-liquidity for swaps
- Earn rewards for successful swaps

### Solver Operations

```
┌─────────────────────────────────────────────────────────┐
│                    Solver Node                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Aztec    │    │   Decision   │    │    Base      │  │
│  │ Watcher  │───►│   Engine     │───►│   Executor   │  │
│  └──────────┘    └──────────────┘    └──────────────┘  │
│        │                                    │          │
│        ▼                                    ▼          │
│  Monitor locks                        Execute locks    │
│  Detect redeems                       Redeem with      │
│  Watch refunds                        revealed secret  │
│                                                        │
└─────────────────────────────────────────────────────────┘
```

### Becoming a Solver

Solvers need:
- USDC liquidity on both Aztec and Base
- A running solver node (monitors events, executes transactions)
- Gas tokens on both chains

The protocol is permissionless - anyone can run a solver.

---

## Security Considerations

### Hashlock Security

The secret must be:
- Generated with cryptographic randomness
- Never reused across swaps
- Kept private until redemption

If the secret is leaked before redemption, anyone could claim the funds.

### Timelock Margins

The protocol enforces minimum timelock margins:
- Solver lock must expire at least 15 minutes after current time
- User has longer timelock than solver

This ensures sufficient time for users to react.

### Failure Modes

| Failure | Who Affected | Recovery |
|---------|--------------|----------|
| User doesn't lock | Nobody | No swap initiated |
| Solver doesn't counter-lock | User | User refunds after timelock |
| User doesn't redeem | Solver | Solver refunds on destination |
| Network issues | Both | Timelocks provide safety window |

---

## Next Steps

- [User Guide](./03-user-guide.md) - Step-by-step instructions
- [Introduction](./01-introduction.md) - Overview and motivation
- [Architecture](./zkzkp2p-architecture.md) - Developer documentation
