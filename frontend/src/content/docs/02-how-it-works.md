# How It Works

![zkzkp2p architecture](/diagram.svg)

## Fund Private Wallet (Base → Aztec)

Move USDC from Base to your private Aztec balance.

**What happens:**

1. Fresh Aztec address generated in your browser
2. Bridge order opened via Substance Labs — your USDC on Base is bridged to USDC on Aztec
3. A solver fills your order on the destination chain
4. Funds arrive at the fresh address with no link to your Base wallet

## Create zkp2p Deposit (Aztec → zkp2p)

Create a zkp2p deposit from your private balance.

**What happens:**

1. Fresh Base address (burner) derived from your MetaMask signature
2. Bridge order opened via Substance Labs — your private Aztec USDC is bridged to USDC on Base
3. Solver fills the order, USDC arrives at a gasless smart account
4. Fresh address creates the zkp2p deposit (gas sponsored by Coinbase paymaster)

**Result:** zkp2p deposit from an address with no transaction history. The Aztec side is encrypted — no one can trace it to you.

## Substance Labs Bridge

[Substance Labs](https://substance.exchange) handles cross-chain bridging between Aztec and EVM chains using an intent-based system. You open an order specifying what you want to send and receive. Solvers compete to fill your order on the destination chain. Once filled, the order is settled and funds are released. If no solver fills in time, you can reclaim your funds.

## How the Wallet Works

zkzkp2p uses Azguard wallet for Aztec and MetaMask for Base. When you click login, both wallets connect sequentially. All proving happens in your browser — the server never sees your keys.
