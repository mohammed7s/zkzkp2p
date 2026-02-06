# Deployments

## Networks

| Network | Chain ID | RPC |
|---------|----------|-----|
| Base | 8453 | `https://mainnet.base.org` |
| Aztec Devnet | — | `https://next.devnet.aztec-labs.com` |

## Tokens

**USDC:** Native USDC on Base, bridged USDC on Aztec devnet.

| Token | Network | Address |
|-------|---------|---------|
| USDC | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDC | Aztec Devnet | Set via `NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS` |

## Bridge

Cross-chain bridging is handled by the [Substance Labs](https://substance.exchange) SDK. Order routing and settlement are managed by the SDK — no custom bridge contracts are deployed.
