import { getAddress } from 'viem';
import deployment from '../lib/deployment-v11-hardened.json';

// One deployment record is shared by VoidScan discovery and every DEX route.
export const DEX = {
  chainId: deployment.chainId,
  deployBlock: deployment.deployBlock,
  manifestHash: deployment.manifestHash,
  releaseId: deployment.releaseId,
  voidscanOrigin: deployment.signingOrigin,
  rpc: 'https://robinhood-testnet.drpc.org',
  rpcUrls: ['https://robinhood-testnet.drpc.org', 'https://rpc.testnet.chain.robinhood.com'],
  voidToken: getAddress(deployment.baseToken),
  runtime: getAddress(deployment.runtime),
  paymaster: getAddress(deployment.paymaster),
  app: getAddress(deployment.app),
  pools: deployment.pools.map((pool, index) => ({
    label: pool.label, address: getAddress(pool.address),
    token0: getAddress(pool.token0), token1: getAddress(pool.token1),
    asset: getAddress(pool.asset), name: index === 0 ? 'Void Test Dollar' : 'Void Test Link',
  })),
};
export const MAX_GAS_VOID = 10000n * 10n ** 18n;
export const CALL_GAS_LIMIT = 700000n;
