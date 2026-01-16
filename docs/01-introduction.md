# zkzkp2p: Private Liquidity for Peer-to-Peer Payments

## What is zkzkp2p?

**zkzkp2p** is a privacy layer for [zkp2p](https://zkp2p.xyz), enabling users to provide liquidity and create deposits without exposing their on-chain financial history.

It combines:
- **Aztec Network** - A privacy-focused L2 with encrypted state and private transactions
- **Train Protocol** - Trustless atomic swaps between Aztec and EVM chains 
- **zkp2p** - Peer-to-peer fiat on/off-ramp using payment verification proofs

The result: **you can fund zkp2p deposits from a completely private source**, breaking the link between your identity and your liquidity provision.

---

## The Problem: On-Chain Transparency

zkp2p has a privacy limitation:

When you deposit USDC on Base to become a liquidity provider, **anyone can see**:

| Exposed Information | Risk |
|---------------------|------|
| Your deposit history | Observers know your liquidity patterns |
| Your funding sources | CEX withdrawals, other wallets visible |
| Your other on-chain activity | Full transaction history linkable |
| Your wallet balances | Net worth estimable |


---

## The Solution: Aztec as Privacy Infrastructure

zkzkp2p uses **Aztec L2** as a privacy layer between your funds and zkp2p:

```
Your Funds → Aztec (private) → Fresh Base Address → zkp2p Deposit
                ↑
         Privacy break
```

**How it achieves privacy:**

1. **Shield your funds** - Move USDC from Base to Aztec, gaining a private balance
2. **Generate a fresh address** - Create a new, unlinkable Base address
3. **Atomic swap** - Bridge from Aztec to the fresh Base address
4. **Create deposit** - Fund zkp2p from the fresh address

**The result**: No observer can link your original funds to your zkp2p liquidity provision.

---

## Key Properties

| Property | Description |
|----------|-------------|
| **Trustless** | No intermediaries. Smart contracts on both chains enforce atomicity. |
| **Private** | Aztec's encrypted state hides your transaction history. |
| **Non-custodial** | You control your funds at all times. Timelocked refunds protect you. |
| **Atomic** | Swaps complete fully or not at all. No partial execution risk. |
| **Permissionless** | Anyone can be a solver. Open protocol. |

---

## Who is zkzkp2p For?

**Liquidity Providers** who want to:
- Participate in zkp2p without revealing funding sources
- Keep deposit amounts and timing private
- Separate their trading identity from their main wallet

**Privacy-Conscious Users** who:
- Value financial confidentiality
- Want to off-ramp to fiat without linking to on-chain history
- Need plausible deniability for liquidity provision

---

## How is it Different from zkp2p?

| Aspect | zkp2p | zkzkp2p |
|--------|-------|---------|
| Deposit visibility | Public on Base | Private via Aztec |
| Funding source | Visible | Hidden |
| Wallet linkage | Full history exposed | Fresh addresses |
| Trust model | Trustless (proofs) | Trustless (proofs + atomic swaps) |

zkzkp2p **extends** zkp2p with a privacy layer. It's not a replacement - it's an enhancement for users who need privacy.

---

## Technology Stack

zkzkp2p is built on proven infrastructure:

- **[Aztec Network](https://aztec.network)** - Privacy-first L2 with encrypted state
- **[Train Protocol](https://github.com/TrainProtocol/contracts)** - HTLC atomic swaps (MIT licensed)
- **[zkp2p](https://zkp2p.xyz)** - P2P fiat on/off-ramp with ZK payment proofs
- **[Azguard Wallet](https://azguard.xyz)** - Browser extension for Aztec

---

## Current Status

zkzkp2p is in **active development** on testnet:
- Aztec Devnet
- Base Sepolia

The core atomic swap flows are working end-to-end. Frontend integration is in progress.

---

## Next Steps

- [How It Works](./02-how-it-works.md) - Technical deep dive into the privacy flows
- [User Guide](./03-user-guide.md) - Step-by-step instructions for using zkzkp2p
- [Architecture](./zkzkp2p-architecture.md) - Developer documentation
