import { NextResponse } from 'next/server';
import { createPublicClient, createWalletClient, decodeFunctionData, encodeFunctionData, fallback, getAddress, http, isAddress, parseAbi, toFunctionSelector, type Address, type Hex } from 'viem';
import { BodyError, readJsonObject } from '../request-body';
import { authenticSponsored } from '../verify-sponsored';
import { DEX, MAX_GAS_VOID, CALL_GAS_LIMIT } from '../dex-config';
import { RelayAdmissionError, relayClientId, reserveRelay, admitRelayIngress } from '../relay-guard';
import { submitDurably } from '../durable-relay';
import { relayerPoolConfigured, selectRelayer } from '../relayer-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RUNTIME = DEX.runtime;
const PAYMASTER = DEX.paymaster;
const VOID = DEX.voidToken;
const DEX_APP = DEX.app.toLowerCase();
const selectors = new Set([
  toFunctionSelector('swap(address,bool,uint256,uint256)'),
  toFunctionSelector('addLiquidity(address,uint256,uint256,uint256)'),
  toFunctionSelector('removeLiquidity(address,uint256,uint256,uint256)'),
  toFunctionSelector('claimTestAssets(uint256)'),
]);
const dexAbi = parseAbi([
  'function swap(address pool,bool zeroForOne,uint256 amountIn,uint256 minAmountOut) returns(uint256)',
  'function addLiquidity(address pool,uint256 amount0,uint256 amount1,uint256 minLiquidity) returns(uint256)',
  'function removeLiquidity(address pool,uint256 liquidity,uint256 min0,uint256 min1) returns(uint256,uint256)',
  'function claimTestAssets(uint256 amountPerAsset)',
]);
const configuredPools = new Map(DEX.pools.map((pool) => [pool.address.toLowerCase(), pool]));
const readAbi = parseAbi(['function nonces(address) view returns(uint256)', 'function feeOf(uint256) view returns(uint256)']);
const paymasterAbi = parseAbi(['function sponsorWithAssetPermits((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes,(address token,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[]) returns(bool,bytes)']);
const transport = fallback(DEX.rpcUrls.map((url) => http(url)));
const rpc = createPublicClient({ transport });
const MAX_DEADLINE_SECONDS = 630n;

type Raw = Record<string, unknown>;
const asAddress = (value: unknown): Address | null => typeof value === 'string' && isAddress(value) ? getAddress(value) : null;
const asUint = (value: unknown): bigint | null => typeof value === 'string' && /^\d{1,78}$/.test(value) && BigInt(value) < (1n << 256n) ? BigInt(value) : null;
const asHex = (value: unknown): Hex | null => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) ? value as Hex : null;
const reject = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Relays only a signed, bounded Chain #1 DEX action. */
export async function POST(request: Request) {
  if (!relayerPoolConfigured()) return reject('VOID relay is not configured.', 503);
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(contentLength) || contentLength > 65_536) return reject('Relay request is too large.', 413);
  let body: Raw;
  try { body = await readJsonObject(request,65_536); } catch(error) { return reject(error instanceof BodyError ? error.message : 'Malformed request.', error instanceof BodyError ? error.status : 400); }
  const raw = body.request as Raw | undefined;
  const rawPermits = body.permits;
  const signature = asHex(body.signature);
  if (!raw || !Array.isArray(rawPermits) || rawPermits.length > 3 || !signature || signature.length !== 132) return reject('Invalid signed request.');

  const user = asAddress(raw.user); const target = asAddress(raw.target); const data = asHex(raw.data);
  const tokenId = asUint(raw.tokenId); const maxToll = asUint(raw.maxToll); const maxGasVoid = asUint(raw.maxGasVoid);
  const callGasLimit = asUint(raw.callGasLimit); const nonce = asUint(raw.nonce); const deadline = asUint(raw.deadline);
  const spendsRaw = raw.spends;
  if (!user || !target || !data || data.length > 4_098 || tokenId !== 1n || maxToll === null || maxGasVoid !== MAX_GAS_VOID || callGasLimit !== CALL_GAS_LIMIT || nonce === null || deadline === null || !Array.isArray(spendsRaw)) return reject('Invalid DEX limits.');
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now || deadline > now + MAX_DEADLINE_SECONDS) return reject('Signature expired.');
  const selector = data.slice(0, 10) as Hex;
  if (target.toLowerCase() !== DEX_APP || !selectors.has(selector)) return reject('Only registered DEX methods can be relayed.');

  const spends: Array<{ token: Address; amount: bigint }> = [];
  for (const item of spendsRaw) {
    if (!item || typeof item !== 'object' || spends.length >= 2) return reject('Invalid app budget.');
    const spend = item as Raw; const token = asAddress(spend.token); const amount = asUint(spend.amount);
    if (!token || amount === null || amount === 0n || spends.some((known) => known.token === token)) return reject('Invalid app budget.');
    spends.push({ token, amount });
  }
  if (spends.length > 2) return reject('Too many app token budgets.');

  // Calldata and token budgets must describe the same exact action. The
  // Runtime enforces the signed ceilings on-chain; this ingress check also
  // refuses malformed requests before the relayer spends ETH on them.
  try {
    const decoded = decodeFunctionData({ abi: dexAbi, data });
    if (decoded.functionName === 'swap') {
      const [poolAddress, zeroForOne, amountIn] = decoded.args;
      const pool = configuredPools.get(poolAddress.toLowerCase());
      if (!pool) return reject('Unknown DEX pool.');
      const inputToken = zeroForOne ? pool.token0 : pool.token1;
      if (spends.length !== 1 || spends[0]!.token.toLowerCase() !== inputToken.toLowerCase() || spends[0]!.amount !== amountIn) {
        return reject('Swap budget does not match the signed action.');
      }
    } else if (decoded.functionName === 'addLiquidity') {
      const [poolAddress, amount0, amount1] = decoded.args;
      const pool = configuredPools.get(poolAddress.toLowerCase());
      if (!pool) return reject('Unknown DEX pool.');
      const expected = new Map([[pool.token0.toLowerCase(), amount0], [pool.token1.toLowerCase(), amount1]]);
      if (spends.length !== 2 || spends.some((spend) => expected.get(spend.token.toLowerCase()) !== spend.amount)) {
        return reject('Liquidity budget does not match the signed action.');
      }
    } else if (decoded.functionName === 'removeLiquidity') {
      const [poolAddress] = decoded.args;
      if (!configuredPools.has(poolAddress.toLowerCase()) || spends.length !== 0) return reject('Invalid liquidity removal budget.');
    } else if (decoded.functionName === 'claimTestAssets') {
      const [amount] = decoded.args;
      if (amount !== 1_000n * 10n ** 18n || spends.length !== 0) return reject('Invalid test-token claim.');
    } else {
      return reject('Unsupported DEX action.');
    }
  } catch {
    return reject('Malformed DEX action.');
  }

  const permits = [] as Array<{ token: Address; spender: Address; value: bigint; deadline: bigint; v: number; r: Hex; s: Hex }>;
  for (const item of rawPermits) {
    if (!item || typeof item !== 'object') return reject('Invalid token permit.');
    const permit = item as Raw; const token = asAddress(permit.token); const spender = asAddress(permit.spender); const value = asUint(permit.value); const permitDeadline = asUint(permit.deadline); const r = asHex(permit.r); const s = asHex(permit.s); const v = permit.v;
    if (!token || !spender || value === null || permitDeadline !== deadline || !r || r.length !== 66 || !s || s.length !== 66 || typeof v !== 'number' || (v !== 27 && v !== 28)) return reject('Invalid token permit.');
    if (permits.some((known) => known.token === token && known.spender === spender)) return reject('Duplicate token permit.');
    permits.push({ token, spender, value, deadline: permitDeadline, v, r: r as Hex, s: s as Hex });
  }
  const required = new Map<string, bigint>([[`${VOID}:${PAYMASTER}`.toLowerCase(), maxToll + maxGasVoid]]);
  for (const spend of spends) required.set(`${spend.token}:${RUNTIME}`.toLowerCase(), spend.amount);
  if (permits.some((permit) => {
    const needed = required.get(`${permit.token}:${permit.spender}`.toLowerCase());
    return needed === undefined || permit.value < needed;
  })) return reject('Permit does not cover a required VOID or app budget.');

  const sponsored = { user, tokenId, target, data, maxToll, maxGasVoid, callGasLimit, spends, nftSpends: [], nonce, deadline };
  try { await admitRelayIngress(relayClientId(request)); }
  catch (error) { return reject(error instanceof Error ? error.message : 'Relay unavailable.', error instanceof RelayAdmissionError ? error.status : 503); }
  if (!await authenticSponsored(sponsored, signature, PAYMASTER)) return reject('Invalid action signature.', 401);
  const [chainNonce, fee] = await Promise.all([
    rpc.readContract({ address: PAYMASTER, abi: readAbi, functionName: 'nonces', args: [user] }),
    rpc.readContract({ address: RUNTIME, abi: readAbi, functionName: 'feeOf', args: [1n] }),
  ]);
  if (nonce !== chainNonce || maxToll !== fee) return reject('Quote changed; sign again.', 409);

  let reservation: Awaited<ReturnType<typeof reserveRelay>>;
  let broadcast = false;
  let broadcastHash: Hex | null = null;
  try {
    reservation = await reserveRelay('voiddex', PAYMASTER, user, nonce, signature, relayClientId(request));
  } catch (error) {
    if (error instanceof RelayAdmissionError) return reject(error.message, error.status);
    return reject('Relay admission control is unavailable.', 503);
  }
  try {
    const account = await selectRelayer(rpc, `${user}:${nonce}:dex`);
    const wallet = createWalletClient({ account, transport });
    const simulation = await rpc.simulateContract({ account, address: PAYMASTER, abi: paymasterAbi, functionName: 'sponsorWithAssetPermits', args: [sponsored, signature, permits] });
    if (!simulation.result[0]) {
      await reservation.failed();
      return reject('The DEX action would fail. No transaction was sent.', 409);
    }
    const submission = await submitDurably(account.address, 'voiddex', {
      nonce: (blockTag) => rpc.getTransactionCount({ address: account.address, blockTag }),
      prepare: async (nonce) => wallet.signTransaction({ ...await wallet.prepareTransactionRequest({
        account, chain: null, nonce, to: PAYMASTER,
        data: encodeFunctionData({ abi: paymasterAbi, functionName: 'sponsorWithAssetPermits', args: [sponsored, signature, permits] }),
      }), account, chain: null }),
      broadcast: (serializedTransaction) => rpc.sendRawTransaction({ serializedTransaction }),
    });
    broadcast = true;
    broadcastHash = submission.hash;
    await reservation.submitted(submission.hash).catch(() => undefined);
    const receipt = await rpc.waitForTransactionReceipt({ hash: submission.hash, timeout: 45_000 });
    await submission.confirmed(receipt.status === 'success');
    if (receipt.status !== 'success') return reject('Sponsored transaction reverted.', 502);
    return NextResponse.json({ hash: submission.hash });
  } catch (error) {
    console.error('VoidDEX relay execution failed', error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: 'Unknown relay failure' });
    if (broadcastHash) return NextResponse.json({hash:broadcastHash,status:'submitted'},{status:202});
    if (!broadcast) await reservation.failed().catch(() => undefined);
    return reject('Relay refused the signed action. Sign a new request and try again.', 502);
  }
}
