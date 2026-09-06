import { createPublicClient, fallback, http, parseAbi, type Address } from 'viem';
import { DEX } from './dex-config';

const rpc = createPublicClient({ transport: fallback(DEX.rpcUrls.map((url) => http(url))) });
const pairAbi = parseAbi(['function reserve0() view returns(uint112)', 'function reserve1() view returns(uint112)', 'function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)']);
const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)']);

export async function canonicalRelease() {
  const response = await fetch(`${DEX.voidscanOrigin}/api/release`, {
    cache: 'no-store', signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error('VoidScan release is unavailable.');
  const release = await response.json() as { chainId?: number; deployBlock?: number; manifestHash?: string; releaseId?: string; signingOrigin?: string };
  if (release.chainId !== DEX.chainId || release.deployBlock !== DEX.deployBlock
    || release.manifestHash !== DEX.manifestHash || release.releaseId !== DEX.releaseId
    || release.signingOrigin !== DEX.voidscanOrigin) {
    throw new Error('VoidScan and VoidDEX release identities do not match. Signing is blocked.');
  }
  return { releaseId: DEX.releaseId, manifestHash: DEX.manifestHash, deployBlock: DEX.deployBlock, releaseReady: true };
}

export async function poolState(index: number, account?: Address) {
  const pair = DEX.pools[index];
  if (!pair) throw new Error('Unknown pool.');
  async function query(name: 'reserve0' | 'reserve1' | 'totalSupply' | 'balanceOf') {
    return (await rpc.readContract({
      address: pair.address,
      abi: pairAbi,
      functionName: name,
      args: (name === 'balanceOf' ? [account!] : []) as never,
    })).toString();
  }
  const [release, fee, reserve0, reserve1, totalSupply, balance] = await Promise.all([
    canonicalRelease(),
    rpc.readContract({ address: DEX.runtime, abi: runtimeAbi, functionName: 'feeOf', args: [1n] }).catch(() => null),
    query('reserve0'), query('reserve1'), query('totalSupply'), account ? query('balanceOf') : '0',
  ]);
  return { ...release, fee: fee?.toString() ?? null, reserve0, reserve1, totalSupply, balance };
}
