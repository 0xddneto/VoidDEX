import { NextResponse } from 'next/server';
import { createPublicClient, fallback, http, keccak256 } from 'viem';
import { DEX } from '../dex-config';
import { pool, sessionPool } from '../relay-guard';
import { relayerPoolStatus } from '../relayer-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const checkedAt = new Date().toISOString();
  try {
    await Promise.all([pool.query('SELECT 1'), sessionPool.query('SELECT 1')]);
    const rpc = createPublicClient({ transport: fallback(DEX.rpcUrls.map((url) => http(url))) });
    const [runtimeCode, paymasterCode, appCode, relayers] = await Promise.all([
      rpc.getBytecode({ address: DEX.runtime }), rpc.getBytecode({ address: DEX.paymaster }),
      rpc.getBytecode({ address: DEX.app }), relayerPoolStatus(rpc),
    ]);
    const bytecodeOk = runtimeCode !== undefined && runtimeCode !== '0x' && keccak256(runtimeCode) === DEX.codeHashes.runtime
      && paymasterCode !== undefined && paymasterCode !== '0x' && keccak256(paymasterCode) === DEX.codeHashes.paymaster
      && appCode !== undefined && appCode !== '0x' && keccak256(appCode) === DEX.codeHashes.app;
    const healthy = relayers.filter((relayer) => relayer.healthy).length;
    const ok = bytecodeOk && healthy > 0;
    return NextResponse.json({ ok, checkedAt, bytecodeOk, relayers: { configured: relayers.length, healthy } }, { status: ok ? 200 : 503 });
  } catch {
    return NextResponse.json({ ok: false, checkedAt, error: 'Relay dependencies are unavailable.' }, { status: 503 });
  }
}
