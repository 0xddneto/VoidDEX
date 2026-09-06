import VoidDex from './DexClient';
import { DEX } from './dex-config';
import { poolState } from './pool-state';

// Pool reserves and the VOID fee are live parent-chain state. Never freeze
// the initial quote into a static build artifact; a transient RPC read during
// deployment must not ship a disabled swap screen.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function Page() {
  try {
    const states = await Promise.all(DEX.pools.map((_, index) => poolState(index)));
    return <VoidDex initialStates={states} />;
  } catch {
    return <main className="shell"><h1>VoidDEX</h1><p>Pool data is temporarily unavailable. Please reload shortly.</p><a href="https://www.voidchains.app">Open VoidScan</a></main>;
  }
}
