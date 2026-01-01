# How It Works

![zkzkp2p architecture](/diagram.svg)

## Fund Private Wallet (Base → Aztec)

Move USDC from Base to your private Aztec balance.

**What happens:**

1. Fresh Aztec address generated in your browser
2. Atomic swap via Train Protocol — your USDC on Base is exchanged for USDC on Aztec
3. Funds arrive at the fresh address with no link to your Base wallet

## Create zkp2p Deposit (Aztec → zkp2p)

Create a zkp2p deposit from your private balance.

**What happens:**

1. Fresh Base address generated in your browser
2. Atomic swap via Train Protocol — your private Aztec USDC is exchanged for USDC on Base
3. Fresh address creates the zkp2p deposit

**Result:** zkp2p deposit from an address with no transaction history. The Aztec side is encrypted — no one can trace it to you.

## Train Protocol

[Train](https://www.train.tech) handles cross-chain atomic swaps using HTLCs. Both sides lock funds with the same secret hash. When one side reveals the secret to claim, the other can use it too. If anything fails, both sides refund after timeout.

## How the Wallet Works

zkzkp2p uses MetaMask as the single source of identity. When you connect, you sign a message that derives your Aztec private keys. All proving happens in your browser — the server never sees your keys.
