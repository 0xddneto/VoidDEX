# VoidDEX

VoidDEX is an independent application deployed inside VOID Chain #1. It
uses a Uniswap V2-style constant-product AMM, but every registered state change
enters through the VoidChain Runtime and is sponsored by the VOID Paymaster.
The wallet signs the exact action; the relayer pays the parent-chain ETH gas,
and the Paymaster charges the bounded execution cost in VOID. VOID itself needs
no approval transaction on V11. External pool assets can still require their
own token authorization before the first transfer.

## What belongs here

- the DEX web application and relay API;
- pair/factory ChainApp contracts;
- DEX deployment and integration scripts;
- the DEX deployment manifest.

The VoidChain protocol, Deed, Runtime, DAO, Paymaster and VoidScan live in the
separate `VoidChainApp` repository. This repository must not duplicate or own
their governance.

## Uniswap attribution

The pair preserves the essential Uniswap V2 mechanics: 50/50 constant product,
0.30% input fee, minimum locked liquidity, transferable LP shares, cumulative
prices and permissionless pair creation. The entry and token-pull paths are
adapted to `ChainAppBase` so direct state-changing wallet calls cannot bypass
the Chain #1 fee. See `docs/UNISWAP_V2_FORK_NOTICE.md`.

## Testnet

Copy `.env.example` to `.env.local`, provide only testnet credentials, and run:

```bash
npm ci
npm run build:contracts
npm run build
npm run dev
```

Never commit private keys or Vercel/relayer secrets.
