# Uniswap V2 fork notice

The contracts in this repository are derived from the architecture and AMM
mathematics of Uniswap V2 core. The upstream project is available at
<https://github.com/Uniswap/v2-core> under GPL-3.0.

VoidDEX deliberately changes the transaction boundary:

- a pair is a registered gateway of exactly one VOID Chain;
- state changes accept calls only from that chain's Runtime;
- `caller()` preserves the real signed user behind the Paymaster;
- token input uses a signed, single-call Runtime budget;
- the parent-chain relayer pays ETH gas and the user is charged in VOID.

These changes mean deployed bytecode is not a drop-in Uniswap V2 pair and must
be audited as its own protocol. The 0.30% invariant and LP accounting remain
covered by unit, fuzz and invariant tests before any public deployment.
