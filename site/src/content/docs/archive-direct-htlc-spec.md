# zkzkp2p.xyz Protocol Specification

> Private Aztec L2 to zkp2p (Base L2) Bridge using Hash Time-Locked Contracts

**Version**: 0.1.0
**Date**: 2024-12-25
**Status**: Draft
**Based on**: [Train Protocol](https://github.com/TrainProtocol/contracts) (MIT License)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Protocol Flow](#3-protocol-flow)
4. [Contracts Specification](#4-contracts-specification)
5. [Security Considerations](#5-security-considerations)
6. [Appendix](#6-appendix)

---

## 1. Overview

### 1.1 Problem Statement

Users with private funds on Aztec L2 want to become liquidity providers (makers) on zkp2p (Base L2). Currently, there is no trustless way to bridge from Aztec to Base and create a zkp2p deposit atomically.

### 1.2 Solution

zkzkp2p uses a Hash Time-Locked Contract (HTLC) on Aztec paired with a Gated Deposit mechanism on Base. The user locks funds on Aztec, the solver creates a dormant zkp2p deposit on Base, and atomic settlement occurs when the secret is revealed.

**Key Insight**: The solver only sees hashes of user details (payee ID, payment method), never the raw values. This preserves user privacy even from the solver.

### 1.3 Key Properties

| Property | Description |
|----------|-------------|
| **Trustless** | No trusted intermediaries; cryptographic guarantees |
| **Atomic** | Either both sides complete or neither does |
| **Privacy-Preserving** | Solver sees only hashes, never raw user details |
| **One-Directional** | Aztec → Base only (optimized for this use case) |
| **Permissionless** | Anyone can be a solver |
| **Non-custodial** | Users and solvers control their own funds |

### 1.4 Actors

| Actor | Description |
|-------|-------------|
| **User** | Wants to bridge Aztec USDC to zkp2p deposit on Base |
| **Solver** | Provides Base liquidity, earns fees, creates zkp2p deposits |
| **Payer** | Eventually fulfills the zkp2p order (outside this protocol) |

### 1.5 What's Different from Train Protocol

| Aspect | Train Protocol | zkzkp2p |
|--------|----------------|---------|
| Direction | Bidirectional | One-way (Aztec → Base) |
| Destination | HTLC on dest chain | Gated zkp2p deposit |
| User details | Raw text on-chain | Hashes only (privacy) |
| Complexity | 8+ functions | 3 functions (lock, redeem, refund) |
| Pattern | 2-step commit + addLock | Single lock step |

---

## 2. Architecture

### 2.1 System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        zkzkp2p.xyz                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐                        ┌──────────────┐       │
│  │   AZTEC L2   │                        │    BASE L2   │       │
│  │              │                        │              │       │
│  │  ┌────────┐  │      Hash Flow         │  ┌────────┐  │       │
│  │  │  HTLC  │──┼───────────────────────▶│  │ Gated  │  │       │
│  │  │Contract│  │  (hashes copied)       │  │Deposit │  │       │
│  │  └────────┘  │                        │  └────────┘  │       │
│  │      │       │                        │      │       │       │
│  │      │       │      Secret Flow       │      │       │       │
│  │      ▼       │◀───────────────────────┼──────┘       │       │
│  │   Redeem     │   (after activation)   │              │       │
│  │              │                        │      │       │       │
│  └──────────────┘                        │      ▼       │       │
│                                          │  ┌────────┐  │       │
│                                          │  │ zkp2p  │  │       │
│                                          │  │ Escrow │  │       │
│                                          │  └────────┘  │       │
│                                          └──────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Directory Structure

```
zkzkp2p/
├── contracts/
│   ├── aztec/
│   │   └── zkp2p_htlc/
│   │       ├── Nargo.toml
│   │       └── src/
│   │           └── main.nr         # ZkP2PHTLC contract
│   │
│   └── base/
│       ├── foundry.toml
│       └── src/
│           └── GatedDeposit.sol    # Gated zkp2p deposit
│
└── scripts/
    ├── setup.ts                    # Create wallets, deploy token
    ├── deploy.ts                   # Deploy Aztec HTLC
    ├── lock.ts                     # User locks on Aztec
    ├── redeem.ts                   # Solver redeems on Aztec
    ├── refund.ts                   # User refunds (timeout)
    ├── base/
    │   ├── deployBase.ts           # Deploy GatedDeposit
    │   ├── createDeposit.ts        # Solver creates deposit
    │   └── activateDeposit.ts      # Activate with secret
    └── e2e.ts                      # Full flow test
```

---

## 3. Protocol Flow

### 3.1 Happy Path Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         HAPPY PATH                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  PHASE 1: USER LOCKS ON AZTEC                                   │
│  ─────────────────────────────                                  │
│                                                                 │
│  1.1  User computes hashes LOCALLY (never shared as raw):      │
│       - payeeDetailsHash = keccak256("@my_revolut_id")         │
│       - paymentMethodHash = keccak256("revolut")               │
│       - currencyHash = keccak256("EUR")                        │
│                                                                 │
│  1.2  User generates secret and hashlock:                      │
│       - secret: random 32 bytes                                │
│       - hashlock: sha256(secret)                               │
│                                                                 │
│  1.3  User calls ZkP2PHTLC.lock() on Aztec:                   │
│       - htlcId: unique identifier                              │
│       - hashlock_high, hashlock_low                            │
│       - timelock: now + 8 hours                                │
│       - solver: solver's Aztec address                         │
│       - token, amount                                          │
│       - payeeDetailsHash                                       │
│       - paymentMethodHash                                      │
│       - currencyHash                                           │
│                                                                 │
│  1.4  Event emitted with ALL hashes (public, but no raw data) │
│                                                                 │
│  PHASE 2: SOLVER CREATES GATED DEPOSIT ON BASE                 │
│  ──────────────────────────────────────────────                 │
│                                                                 │
│  2.1  Solver monitors Aztec logs for lock events               │
│                                                                 │
│  2.2  Solver reads hashes from Aztec:                          │
│       - Does NOT know raw "@my_revolut_id"                     │
│       - Just copies the hash values                            │
│                                                                 │
│  2.3  Solver calls GatedDeposit.createDeposit() on Base:       │
│       - htlcId (same as Aztec)                                 │
│       - hashlock (same as Aztec)                               │
│       - payeeDetailsHash (copied from Aztec)                   │
│       - paymentMethodHash (copied from Aztec)                  │
│       - currencyHash (copied from Aztec)                       │
│       - timelock: now + 4 hours (shorter than Aztec)          │
│                                                                 │
│  2.4  Deposit is DORMANT (not yet usable in zkp2p)            │
│                                                                 │
│  PHASE 3: ACTIVATION + REDEMPTION                              │
│  ─────────────────────────────────                              │
│                                                                 │
│  3.1  User activates deposit by revealing secret:              │
│       GatedDeposit.activateDeposit(htlcId, secret)             │
│                                                                 │
│  3.2  Deposit becomes ACTIVE in zkp2p                          │
│       - Secret is now PUBLIC (in Base tx logs)                 │
│                                                                 │
│  3.3  Solver uses revealed secret to redeem on Aztec:          │
│       ZkP2PHTLC.redeem(htlcId, secret_high, secret_low)        │
│                                                                 │
│  3.4  Solver receives user's locked funds                      │
│                                                                 │
│  RESULT:                                                        │
│  ───────                                                        │
│  - User: Has active zkp2p deposit on Base                      │
│  - Solver: Has USDC on Aztec                                   │
│  - Privacy: Solver never learned raw user details              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Data Flow Diagram

```
USER (local)                    AZTEC                  BASE
────────────                    ─────                  ────

1. Compute hashes locally
   @revolut_id → hash1
   revolut → hash2
   EUR → hash3

2. Generate secret
   secret → hashlock

3. lock(hashlock, hash1,   ───▶  Store HTLC
         hash2, hash3)           Emit event
                                     │
                                     │ Solver reads
                                     │ hashes (not raw)
                                     ▼
                            4. createDeposit(    ───▶  Store Deposit
                               hashlock, hash1,        (DORMANT)
                               hash2, hash3)

5. User calls             ─────────────────────▶  activateDeposit(
   activateDeposit                                   secret)
   on Base                                        Deposit ACTIVE
                                                  Secret PUBLIC
                                     │
                                     │ Secret visible in logs
                                     ▼
                            6. redeem(secret)
                               Solver gets funds
```

### 3.3 Timeout/Refund Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                       REFUND FLOW                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  SCENARIO: User locks on Aztec, solver creates deposit,        │
│            but user doesn't activate (changes mind, etc.)      │
│                                                                 │
│  Timeline:                                                      │
│  ─────────                                                      │
│  T+0hr:    User locks on Aztec (timelock: 8hr)                 │
│  T+1hr:    Solver creates gated deposit (timelock: 4hr)        │
│  ...                                                            │
│  T+4hr:    Base timelock expires                               │
│  T+4hr+:   Solver calls GatedDeposit.cancelDeposit()           │
│            → Solver gets funds back                            │
│                                                                 │
│  T+8hr:    Aztec timelock expires                              │
│  T+8hr+:   User calls ZkP2PHTLC.refund()                       │
│            → User gets USDC back                               │
│                                                                 │
│  RESULT:                                                        │
│  ───────                                                        │
│  - User: Got funds back (but lost time)                        │
│  - Solver: Got funds back                                       │
│  - No deposit was created                                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.4 Timelock Requirements

```
CRITICAL: Base timelock MUST be shorter than Aztec timelock

Aztec:  ████████████████████████████████████████  (8 hours)
Base:   ████████████████████                      (4 hours)
        ↑                   ↑                    ↑
        lock                Base expires         Aztec expires
                            (solver can cancel)  (user can refund)

Minimum gap: 2 hours (recommended: 4 hours)
```

---

## 4. Contracts Specification

### 4.1 Aztec Contract: ZkP2PHTLC.nr

#### 4.1.1 HTLC Struct

```noir
struct HTLC {
    sender: AztecAddress,           // User who locked funds
    solver: AztecAddress,           // Can redeem with secret
    token: AztecAddress,            // Token contract
    amount: U128,                   // Amount locked

    hashlock_high: u128,            // SHA256 hash (upper 128 bits)
    hashlock_low: u128,             // SHA256 hash (lower 128 bits)
    secret_high: u128,              // Revealed on redeem
    secret_low: u128,               // Revealed on redeem

    timelock: u64,                  // Unix timestamp for expiry
    status: u8,                     // 0=empty, 1=active, 2=refunded, 3=redeemed

    // zkp2p deposit params (HASHES ONLY - solver copies to Base)
    payee_details_hash: Field,      // keccak256(payee identifier)
    payment_method_hash: Field,     // keccak256(payment method)
    currency_hash: Field,           // keccak256(currency code)
}
```

#### 4.1.2 Functions

```noir
/// Lock funds with zkp2p deposit params (hashes only)
/// Called by: User
#[public]
fn lock(
    htlc_id: Field,
    hashlock_high: u128,
    hashlock_low: u128,
    timelock: u64,
    solver: AztecAddress,
    token: AztecAddress,
    amount: U128,
    payee_details_hash: Field,
    payment_method_hash: Field,
    currency_hash: Field,
) -> void

/// Redeem funds with secret
/// Called by: Solver (after getting secret from Base activation)
#[public]
fn redeem(
    htlc_id: Field,
    secret_high: u128,
    secret_low: u128,
) -> void

/// Refund after timelock expires
/// Called by: Original sender (user)
#[public]
fn refund(htlc_id: Field) -> void

/// Get HTLC details
#[public]
#[view]
fn get_htlc(htlc_id: Field) -> HTLC
```

#### 4.1.3 Events

```noir
struct HTLCLocked {
    htlc_id: Field,
    sender: AztecAddress,
    solver: AztecAddress,
    token: AztecAddress,
    amount: U128,
    hashlock_high: u128,
    hashlock_low: u128,
    timelock: u64,
    payee_details_hash: Field,
    payment_method_hash: Field,
    currency_hash: Field,
}

struct HTLCRedeemed {
    htlc_id: Field,
    secret_high: u128,
    secret_low: u128,
}

struct HTLCRefunded {
    htlc_id: Field,
}
```

---

### 4.2 Base Contract: GatedDeposit.sol

#### 4.2.1 Deposit Struct

```solidity
struct Deposit {
    address solver;
    address token;
    uint256 amount;

    bytes32 hashlock;               // SHA256 hash for atomic swap

    uint48 timelock;
    bool active;                    // Becomes true when secret revealed
    bool cancelled;

    // zkp2p params (copied from Aztec - solver never sees raw values)
    bytes32 payeeDetailsHash;
    bytes32 paymentMethodHash;
    bytes32 currencyHash;
}

mapping(bytes32 => Deposit) public deposits;
```

#### 4.2.2 Functions

```solidity
/// Create a gated deposit (dormant until activated)
/// Called by: Solver
function createDeposit(
    bytes32 htlcId,
    bytes32 hashlock,
    address token,
    uint256 amount,
    bytes32 payeeDetailsHash,
    bytes32 paymentMethodHash,
    bytes32 currencyHash,
    uint48 timelock
) external;

/// Activate deposit by revealing secret
/// Called by: Solver (or anyone with secret)
function activateDeposit(
    bytes32 htlcId,
    uint128 secretHigh,
    uint128 secretLow
) external;

/// Cancel deposit after timelock (if not activated)
/// Called by: Solver
function cancelDeposit(bytes32 htlcId) external;

/// Get deposit details
function getDeposit(bytes32 htlcId) external view returns (Deposit memory);
```

#### 4.2.3 Events

```solidity
event DepositCreated(
    bytes32 indexed htlcId,
    address indexed solver,
    uint256 amount,
    bytes32 hashlock,
    bytes32 payeeDetailsHash,
    bytes32 paymentMethodHash,
    bytes32 currencyHash
);

event DepositActivated(
    bytes32 indexed htlcId,
    uint128 secretHigh,
    uint128 secretLow
);

event DepositCancelled(bytes32 indexed htlcId);
```

---

## 5. Security Considerations

### 5.1 Privacy Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     WHO KNOWS WHAT                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Data                    │ User │ Solver │ Payer │ Public      │
│  ────────────────────────┼──────┼────────┼───────┼─────────    │
│  Raw payee details       │  ✓   │   ✗    │   ✓   │   ✗         │
│  (e.g. "@revolut_id")    │      │        │       │             │
│                          │      │        │       │             │
│  Payee details HASH      │  ✓   │   ✓    │   ✓   │   ✓         │
│                          │      │        │       │             │
│  Secret (before reveal)  │  ✓   │   ✗    │   ✗   │   ✗         │
│                          │      │        │       │             │
│  Secret (after reveal)   │  ✓   │   ✓    │   ✓   │   ✓         │
│                          │      │        │       │             │
│  Amount                  │  ✓   │   ✓    │   ✓   │   ✓         │
│                          │      │        │       │             │
└─────────────────────────────────────────────────────────────────┘

KEY INSIGHT: Solver bridges funds without ever knowing user's identity
```

### 5.2 Threat Model

| Threat | Mitigation |
|--------|------------|
| Solver doesn't create deposit | User can refund after Aztec timelock |
| Solver creates wrong hashes | On-chain verification - must match Aztec |
| Secret leaked early | User controls when to share with solver |
| Solver front-runs activation | Solver reveals secret, enabling Aztec redeem anyway |
| Timelock race condition | 4-hour gap between Base and Aztec timelocks |

### 5.3 Timelock Guidelines

```
RECOMMENDED TIMELOCKS:
- Aztec: 8 hours
- Base: 4 hours
- Gap: 4 hours minimum

MINIMUM TIMELOCKS:
- Aztec: 4 hours
- Base: 2 hours
- Gap: 2 hours minimum
```

---

## 6. Appendix

### 6.1 Hash Functions

| Purpose | Algorithm | Why |
|---------|-----------|-----|
| Hashlock (atomic swap) | SHA-256 | Standard for HTLCs, 256-bit output |
| Deposit params | Keccak-256 | Matches Solidity's `keccak256()` |

### 6.2 Field Sizes (Noir)

| Field | Size | Notes |
|-------|------|-------|
| hashlock_high | u128 | SHA-256 is 256 bits, split in two |
| hashlock_low | u128 | |
| secret_high | u128 | Same split |
| secret_low | u128 | |
| payee_details_hash | Field | ~254 bits, fits keccak256 |

### 6.3 Test Addresses (Base Sepolia)

```
USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2024-12-25 | Initial spec with hash-only approach |

---

## License

This specification is released under MIT License.

Based on [Train Protocol](https://github.com/TrainProtocol/contracts) - Copyright (c) 2025 TRAIN Protocol.
