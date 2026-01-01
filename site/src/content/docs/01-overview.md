# Overview

zkzkp2p is a privacy layer for [zkp2p](https://zkp2p.xyz). It lets you create deposits without exposing your wallet history.

## Why zkzkp2p

When you offramp on zkp2p, your deposit is public. The fiat buyer sees your wallet address and can link it to your name on the payment method (Revolut, Venmo, etc). Your funding source, balances, and transaction history are all visible.

zkzkp2p breaks this link. Your deposit comes directly from your private balance.


## What It Does

- **Deposit to Private Wallet** — Move funds from Base to your private Aztec balance

- **Create zkp2p Deposit** — Create a zkp2p deposit directly from your private balance

Both operations are non-custodial, client-side, and trustless.

## Built On

- [Aztec](https://aztec.network) — Privacy L2 for encrypted state
- [Train Protocol](https://www.train.tech) — Cross-chain atomic swaps using HTLC
- [zkp2p](https://zkp2p.xyz) — P2P fiat on/off ramp
