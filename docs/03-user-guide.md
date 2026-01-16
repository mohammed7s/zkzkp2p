# zkzkp2p User Guide

This guide walks you through using zkzkp2p to privately provide liquidity on zkp2p.

---

## Prerequisites

Before starting, you'll need:

### Wallets

| Wallet | Purpose | Install |
|--------|---------|---------|
| **MetaMask** | Base chain transactions | [metamask.io](https://metamask.io) |
| **Azguard** | Aztec private transactions | [azguard.xyz](https://azguard.xyz) |

### Funds

| Asset | Chain | Purpose |
|-------|-------|---------|
| USDC | Base Sepolia | Shield to Aztec, or provide liquidity |
| ETH | Base Sepolia | Gas for Base transactions |
| (No ETH needed) | Aztec | Fees are sponsored |

### Network Configuration

**Base Sepolia** (testnet):
- Network Name: Base Sepolia
- RPC URL: `https://sepolia.base.org`
- Chain ID: 84532
- Currency: ETH
- Explorer: `https://sepolia.basescan.org`

**Aztec Devnet**:
- Automatically configured in Azguard

---

## Getting Started

### Step 1: Install Wallets

1. Install **MetaMask** browser extension
2. Install **Azguard** browser extension
3. Create or import accounts in both wallets

### Step 2: Get Testnet Funds

**Base Sepolia ETH** (for gas):
- Use a faucet like [Alchemy Base Sepolia Faucet](https://www.alchemy.com/faucets/base-sepolia)
- You need ~0.01 ETH for transactions

**Base Sepolia USDC** (for swaps):
- Mint from the test token contract, or
- Request from the team

### Step 3: Connect to zkzkp2p

1. Visit the zkzkp2p app
2. Click **Connect Wallet**
3. Connect your MetaMask (Base)
4. Click **Connect Aztec**
5. Approve the Azguard connection

You should see both wallets connected in the header.

---

## Flow 1: Shield (Base → Aztec)

Shield your USDC from Base to get a private balance on Aztec.

### When to Use

- You have USDC on Base and want privacy
- You want to accumulate private funds for later deposits
- You're preparing for multiple zkp2p deposits

### Step-by-Step

#### 1. Select Shield Direction

```
┌─────────────────────────────────────────┐
│          Shield USDC                    │
│                                         │
│   From: Base          To: Aztec         │
│   [USDC icon]    →    [Private icon]    │
│                                         │
│   Amount: [_______] USDC                │
│                                         │
│   [ Shield ]                            │
└─────────────────────────────────────────┘
```

#### 2. Enter Amount

- Enter the USDC amount you want to shield
- Check your available balance shown below the input
- Note: A small fee (~10%) goes to the solver

#### 3. Approve Token

If this is your first time:
- Click **Approve USDC**
- Confirm in MetaMask
- Wait for confirmation

#### 4. Lock on Base

- Click **Shield**
- Confirm the transaction in MetaMask
- Wait for the lock to be confirmed

```
Status: Locking on Base...
TX: 0x123... [View on Explorer]
```

#### 5. Wait for Solver

The solver monitors Base for lock events and creates a counter-lock on Aztec.

```
Status: Waiting for solver...
This typically takes 1-3 minutes.
```

#### 6. Redeem on Aztec

Once the solver locks on Aztec:
- The app automatically prompts you to redeem
- Click **Redeem on Aztec**
- Confirm in Azguard
- Wait for the Aztec transaction

```
Status: Redeeming on Aztec...
This may take 2-3 minutes (proof generation).
```

#### 7. Complete

Your private balance on Aztec is now updated!

```
✓ Shield Complete!

Aztec Private Balance: 100 USDC
```

---

## Flow 2: Deposit (Aztec → zkp2p)

Create a zkp2p deposit from your private Aztec balance.

### When to Use

- You have private USDC on Aztec
- You want to provide zkp2p liquidity without revealing your identity
- Maximum privacy: fresh address + private source

### Step-by-Step

#### 1. Select Deposit Direction

```
┌─────────────────────────────────────────┐
│          Create zkp2p Deposit           │
│                                         │
│   From: Aztec         To: zkp2p         │
│   [Private icon]  →   [zkp2p icon]      │
│                                         │
│   Amount: [_______] USDC                │
│                                         │
│   [ Create Deposit ]                    │
└─────────────────────────────────────────┘
```

#### 2. Configure Deposit

Enter your deposit parameters:
- **Amount**: How much USDC to deposit
- **Payment Method**: Revolut, Venmo, etc.
- **Currency**: USD, EUR, GBP, etc.

#### 3. Lock on Aztec

- Click **Create Deposit**
- Confirm in Azguard
- Wait for the Aztec lock (2-3 minutes for proving)

```
Status: Locking on Aztec...
Generating zero-knowledge proof...
```

#### 4. Wait for Solver

The solver:
1. Detects your lock on Aztec
2. Generates a fresh Base address for you
3. Locks USDC to that fresh address

```
Status: Waiting for solver...
Solver is creating counter-lock on Base.
```

#### 5. Redeem on Base

When the solver's lock is ready:
- The app generates your fresh Base address
- Click **Redeem on Base**
- Sign with your Aztec wallet (Azguard)

```
Status: Redeeming to fresh address...
Fresh address: 0xABC...789
```

#### 6. Create zkp2p Deposit

The fresh address now has USDC. The app automatically:
- Calls zkp2p's `createDeposit`
- Funds the deposit from the fresh address

```
Status: Creating zkp2p deposit...
```

#### 7. Complete

Your deposit is now live on zkp2p!

```
✓ Deposit Created!

Deposit ID: #12345
Amount: 100 USDC
Payment: Revolut
Status: Active

[View on zkp2p →]
```

---

## Managing Your Positions

### View Balances

The app shows your balances across chains:

```
┌─────────────────────────────────────────┐
│   Your Balances                     ↻   │
├─────────────────────────────────────────┤
│   Base USDC (Public):      500.00       │
│   Aztec USDC (Private):    200.00       │
│   Aztec USDC (Public):       0.00       │
└─────────────────────────────────────────┘
```

- Click ↻ to refresh balances
- Private balances take a few seconds to decrypt

### View Deposits

See your zkp2p deposits and their status:

```
┌─────────────────────────────────────────┐
│   Your zkp2p Deposits                   │
├─────────────────────────────────────────┤
│   #12345  100 USDC  Revolut  Active     │
│   #12346   50 USDC  Venmo    Pending    │
└─────────────────────────────────────────┘
```

---

## Troubleshooting

### "Waiting for solver" takes too long

- Solvers typically respond within 1-5 minutes
- If waiting longer than 10 minutes, the solver may be offline
- Your funds are safe - you can refund after the timelock expires

### Transaction stuck or failed

- Check your gas balance on Base
- For Aztec transactions, proof generation can take 2-3 minutes
- If a transaction fails, try refreshing the page

### Balance shows 0

- Private balances require Azguard to decrypt notes
- Click the refresh button to re-fetch
- Make sure Azguard is connected and unlocked

### Fresh address has no ETH

- For testnet, the fresh address is funded via the swap
- Gas for `createDeposit` is included in the flow

---

## Security Best Practices

### Do

- Verify you're on the correct website
- Double-check amounts before confirming
- Keep your wallet recovery phrases safe
- Use a hardware wallet for large amounts

### Don't

- Share your secret key or recovery phrase
- Rush through transactions without checking
- Use the same fresh address twice
- Ignore failed transaction warnings

---

## Fees

| Fee Type | Amount | Paid To |
|----------|--------|---------|
| Solver reward | ~10% | Solver |
| Aztec gas | Sponsored | (Free) |
| Base gas | ~$0.01 | Network |
| zkp2p deposit fee | Variable | zkp2p |

---

## Getting Help

- **Docs**: Read the [Introduction](./01-introduction.md) and [How It Works](./02-how-it-works.md)
- **Issues**: Report bugs on GitHub
- **Community**: Join the Discord

---

## Appendix: Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         zkzkp2p Frontend                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   MetaMask   │    │   Azguard    │    │   zkp2p SDK  │      │
│  │   (wagmi)    │    │   (Aztec)    │    │              │      │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│  ┌──────────────────────────────────────────────────────┐      │
│  │                  State Management                     │      │
│  │                    (zustand)                          │      │
│  └──────────────────────────────────────────────────────┘      │
│         │                   │                   │               │
└─────────┼───────────────────┼───────────────────┼───────────────┘
          │                   │                   │
          ▼                   ▼                   ▼
    ┌──────────┐       ┌──────────┐       ┌──────────────┐
    │   Base   │       │  Aztec   │       │    zkp2p     │
    │  (Train) │◄─────►│  (Train) │       │   (Escrow)   │
    └──────────┘       └──────────┘       └──────────────┘
          ▲                   ▲
          │                   │
          └───────────────────┘
                 Solver
```

**Components**:
- **Frontend**: React SPA with dual wallet support
- **MetaMask**: Base chain interactions via wagmi
- **Azguard**: Aztec interactions via browser extension
- **Train Protocol**: HTLC contracts on both chains
- **Solver**: Off-chain service monitoring and executing swaps
- **zkp2p**: Final deposit destination

---

## Next Steps

- [Introduction](./01-introduction.md) - Learn why zkzkp2p exists
- [How It Works](./02-how-it-works.md) - Technical deep dive
- [Architecture](./zkzkp2p-architecture.md) - Developer docs
