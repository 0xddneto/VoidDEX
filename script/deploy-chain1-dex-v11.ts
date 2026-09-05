/** Deploys one canonical V11 DEX application on clean VOID Chain #1. */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, decodeEventLog, decodeFunctionResult,
  encodeDeployData, encodeFunctionData, fallback, getAddress, http, keccak256,
  parseAbi, parseEther, toHex, type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const VERSION = 'v11-definitive-chainapp-testnet';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const corePath = resolve(root, process.env.V11_CORE_RECORD_FILE ?? '../VoidChainApp/script/deployments/testnet-v11-hardened.json');
const configPath = resolve(root, process.env.V11_DEX_CONFIG_FILE ?? 'lib/deployment-v11-hardened.json');
if (!existsSync(corePath)) throw Error(`Clean V11 core checkpoint not found: ${corePath}`);
const core = JSON.parse(readFileSync(corePath, 'utf8'));
if (core.version !== VERSION || core.status !== 'awaiting-clean-v11-dex') throw Error('Clean V11 core is not ready for its DEX');

const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw Error('Missing testnet deployment key');
const account = privateKeyToAccount(key as Hex);
if (account.address.toLowerCase() !== core.owner.toLowerCase()) throw Error('DEX bootstrap must be executed by Chain #1 owner');
const urls = [process.env.PARENT_RPC, core.network.rpc, 'https://rpc.testnet.chain.robinhood.com'].filter(Boolean) as string[];
const transport = fallback(urls.map((url) => http(url)));
const rpc = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport });
if (await rpc.getChainId() !== 46_630) throw Error('Robinhood testnet only');

type Checkpoint = {
  version: string; status: string; chainTokenId: number; runtime: Address; paymaster: Address;
  appFactory: Address; app?: Address; implementation?: Address; baseToken: Address; escrow: Address;
  assets?: { tUsd?: Address; tLink?: Address };
  pools?: Array<{ address: Address; label: string; asset: Address; token0: Address; token1: Address }>;
  excludedAccounts?: Address[]; steps: Record<string, Hex>;
};
const record: Checkpoint = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {
  version: VERSION, status: 'deploying', chainTokenId: 1,
  runtime: getAddress(core.contracts.runtime), paymaster: getAddress(core.contracts.paymaster),
  appFactory: getAddress(core.contracts.appFactory), baseToken: getAddress(core.contracts.token),
  escrow: getAddress(core.contracts.escrow), steps: {},
};
if (record.version !== VERSION || record.runtime.toLowerCase() !== core.contracts.runtime.toLowerCase()) {
  throw Error('DEX checkpoint belongs to another release');
}
const save = () => writeFileSync(configPath, `${JSON.stringify(record, null, 2)}\n`);

function artifact(name: string) {
  const value = JSON.parse(readFileSync(resolve(root, `out/${name}.sol/${name}.json`), 'utf8'));
  const raw = value.bytecode.object as string;
  return { abi: value.abi as Abi, bytecode: (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex };
}
async function receipt(hash: Hex) {
  const value = await rpc.waitForTransactionReceipt({ hash });
  if (value.status !== 'success') throw Error(`Transaction reverted: ${hash}`);
  return value;
}
async function gasPrice() { return (await rpc.getGasPrice()) * 3n; }
async function deploy(label: string, name: string, args: readonly unknown[]) {
  const existing = label === 'implementation' ? record.implementation : record.assets?.[label as 'tUsd' | 'tLink'];
  if (existing) return getAddress(existing);
  const built = artifact(name);
  const data = encodeDeployData({ ...built, args });
  const estimated = await rpc.estimateGas({ account: account.address, data });
  const hash = await wallet.sendTransaction({ account, chain: null, data, gas: estimated * 3n / 2n, maxFeePerGas: await gasPrice(), maxPriorityFeePerGas: 0n });
  const done = await receipt(hash);
  if (!done.contractAddress) throw Error(`${label} deployment address missing`);
  const address = getAddress(done.contractAddress);
  if (label === 'implementation') record.implementation = address;
  else record.assets = { ...record.assets, [label]: address };
  record.steps[`deploy:${label}`] = hash; save();
  console.log(`${label}: ${address}`);
  return address;
}
async function send(label: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  if (record.steps[label]) return receipt(record.steps[label]);
  const data = encodeFunctionData({ abi, functionName: functionName as never, args: args as never });
  const estimated = await rpc.estimateGas({ account: account.address, to, data });
  const hash = await wallet.sendTransaction({ account, chain: null, to, data, gas: estimated * 3n / 2n, maxFeePerGas: await gasPrice(), maxPriorityFeePerGas: 0n });
  record.steps[label] = hash; save();
  return receipt(hash);
}

const runtime = record.runtime;
const paymaster = record.paymaster;
const voidToken = record.baseToken;
const dexArt = artifact('VoidDexV11');
const pairArt = artifact('VoidDexPairV11');
const tokenArt = artifact('VoidDexTestTokenV11');
const tUsd = await deploy('tUsd', 'VoidDexTestTokenV11', ['Void Test Dollar', 'tUSD', account.address]);
const tLink = await deploy('tLink', 'VoidDexTestTokenV11', ['Void Test Link', 'tLINK', account.address]);
const implementation = await deploy('implementation', 'VoidDexV11', [runtime, 1n, account.address, tUsd, tLink]);

const factoryArt = JSON.parse(readFileSync(resolve(root, '../VoidChainApp/out/VoidChainAppFactoryV11.sol/VoidChainAppFactoryV11.json'), 'utf8'));
const factoryAbi = factoryArt.abi as Abi;
if (!record.app) {
  const published = await send('publish:dex', record.appFactory, factoryAbi, 'publish', [1n, implementation, '0x', keccak256(toHex('void-v11-dex'))]);
  const log = published.logs.find((item) => item.address.toLowerCase() === record.appFactory.toLowerCase());
  if (!log) throw Error('DEX publication event missing');
  const event = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
  record.app = getAddress((event.args as unknown as { app: Address }).app); save();
}
const app = record.app;
await send('token:tUsd-minter', tUsd, tokenArt.abi, 'setDexOnce', [app]);
await send('token:tLink-minter', tLink, tokenArt.abi, 'setDexOnce', [app]);

const escrowArt = JSON.parse(readFileSync(resolve(root, '../VoidChainApp/out/VoidGenesisEscrowV11.sol/VoidGenesisEscrowV11.json'), 'utf8'));
await send('escrow:dex-bootstrap', record.escrow, escrowArt.abi as Abi, 'releaseDexBootstrapOnce', [account.address]);

const gatewayAbi = parseAbi(['function query(bytes) view returns(bytes)']);
async function query(target: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const data = encodeFunctionData({ abi, functionName: functionName as never, args: args as never });
  const response = await rpc.readContract({ address: target, abi: gatewayAbi, functionName: 'query', args: [data] }) as Hex;
  return decodeFunctionResult({ abi, functionName: functionName as never, data: response });
}
const paymasterAbi = parseAbi([
  'function nonces(address) view returns(uint256)',
  'function sponsorWithAssetPermits((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes,(address token,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[]) returns(bool,bytes)',
]);
const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)']);
const tokenAbi = parseAbi(['function nonces(address) view returns(uint256)','function name() view returns(string)']);
const sponsoredTypes = {
  Spend: [{name:'token',type:'address'},{name:'amount',type:'uint256'}],
  SpendNft: [{name:'collection',type:'address'},{name:'tokenId',type:'uint256'}],
  SponsoredCall: [
    {name:'user',type:'address'},{name:'tokenId',type:'uint256'},{name:'target',type:'address'},{name:'data',type:'bytes'},
    {name:'maxToll',type:'uint256'},{name:'maxGasVoid',type:'uint256'},{name:'callGasLimit',type:'uint256'},
    {name:'spends',type:'Spend[]'},{name:'nftSpends',type:'SpendNft[]'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'},
  ],
} as const;
const permitTypes = { Permit: [
  {name:'owner',type:'address'},{name:'spender',type:'address'},{name:'value',type:'uint256'},
  {name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'},
] } as const;
const split = (sig: Hex) => ({ v: Number.parseInt(sig.slice(130,132),16), r: sig.slice(0,66) as Hex, s: `0x${sig.slice(66,130)}` as Hex });
async function sponsored(label: string, data: Hex, spends: Array<{token: Address; amount: bigint}>) {
  if (record.steps[label]) {
    const previous = await rpc.getTransactionReceipt({hash: record.steps[label]});
    if (previous.status === 'success') return previous;
    delete record.steps[label]; save();
  }
  const [nonce, fee] = await Promise.all([
    rpc.readContract({address:paymaster,abi:paymasterAbi,functionName:'nonces',args:[account.address]}) as Promise<bigint>,
    rpc.readContract({address:runtime,abi:runtimeAbi,functionName:'feeOf',args:[1n]}) as Promise<bigint>,
  ]);
  const deadline = BigInt(Math.floor(Date.now()/1000)+600);
  const request = {user:account.address,tokenId:1n,target:app,data,maxToll:fee,maxGasVoid:parseEther('20000'),callGasLimit:3_000_000n,spends,nftSpends:[],nonce,deadline};
  const permits = [] as Array<{token:Address;spender:Address;value:bigint;deadline:bigint;v:number;r:Hex;s:Hex}>;
  for (const spend of spends) {
    if (spend.token.toLowerCase() === voidToken.toLowerCase()) continue;
    const [permitNonce, name] = await Promise.all([
      rpc.readContract({address:spend.token,abi:tokenAbi,functionName:'nonces',args:[account.address]}) as Promise<bigint>,
      rpc.readContract({address:spend.token,abi:tokenAbi,functionName:'name'}) as Promise<string>,
    ]);
    const sig = await account.signTypedData({domain:{name,version:'1',chainId:46_630,verifyingContract:spend.token},types:permitTypes,primaryType:'Permit',message:{owner:account.address,spender:runtime,value:spend.amount,nonce:permitNonce,deadline}});
    permits.push({token:spend.token,spender:runtime,value:spend.amount,deadline,...split(sig)});
  }
  const signature = await account.signTypedData({domain:{name:'VoidPaymaster',version:'1',chainId:46_630,verifyingContract:paymaster},types:sponsoredTypes,primaryType:'SponsoredCall',message:request});
  const estimated = await rpc.estimateContractGas({account:account.address,address:paymaster,abi:paymasterAbi,functionName:'sponsorWithAssetPermits',args:[request,signature,permits]});
  const hash = await wallet.writeContract({account,chain:null,address:paymaster,abi:paymasterAbi,functionName:'sponsorWithAssetPermits',args:[request,signature,permits],gas:estimated*3n/2n,maxFeePerGas:await gasPrice(),maxPriorityFeePerGas:0n} as never);
  record.steps[label]=hash; save(); return receipt(hash);
}

await sponsored('dex:claim-assets', encodeFunctionData({abi:dexArt.abi,functionName:'claimTestAssets',args:[parseEther('500000')]}), []);
for (const [asset,label] of [[tUsd,'VOID / tUSD'],[tLink,'VOID / tLINK']] as const) {
  let pool = await query(app,dexArt.abi,'poolFor',[voidToken,asset]) as Address;
  if (/^0x0{40}$/i.test(pool)) {
    await sponsored(`dex:create:${label}`,encodeFunctionData({abi:dexArt.abi,functionName:'createPool',args:[voidToken,asset]}),[]);
    pool = await query(app,dexArt.abi,'poolFor',[voidToken,asset]) as Address;
  }
  const token0 = await rpc.readContract({address:pool,abi:pairArt.abi,functionName:'token0'}) as Address;
  const token1 = await rpc.readContract({address:pool,abi:pairArt.abi,functionName:'token1'}) as Address;
  const totalSupply = await rpc.readContract({address:pool,abi:pairArt.abi,functionName:'totalSupply'}) as bigint;
  if (totalSupply === 0n) {
    const amount = parseEther('500000');
    await sponsored(`dex:seed:${label}`,encodeFunctionData({abi:dexArt.abi,functionName:'addLiquidity',args:[pool,amount,amount,amount-1_000n]}),[{token:token0,amount},{token:token1,amount}]);
  }
  record.pools = [...(record.pools??[]).filter((item)=>item.label!==label),{address:getAddress(pool),label,asset,token0,token1}]; save();
}
record.excludedAccounts = record.pools!.map((pool)=>pool.address);
record.status='ready'; save();
console.log(`Clean V11 DEX ready: ${app}; 2 internal pools, 1 registered application.`);
