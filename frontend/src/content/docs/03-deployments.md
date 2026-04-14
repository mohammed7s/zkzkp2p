# Deployments

## Networks

| Network | Chain ID | RPC |
|---------|----------|-----|
| Base | 8453 | `https://mainnet.base.org` |
| Aztec Testnet | 11155111 (Sepolia L1) | `https://rpc.testnet.aztec-labs.com` |

## Tokens

**USDC:** Native USDC on Base, bridged USDC on Aztec testnet.

| Token | Network | Address |
|-------|---------|---------|
| USDC | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDC | Aztec Testnet | Set via `NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS` |

## Bridge

Cross-chain bridging is handled by the [Substance Labs](https://substance.exchange) SDK. Order routing and settlement are managed by the SDK — no custom bridge contracts are deployed.
