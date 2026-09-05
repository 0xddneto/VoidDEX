import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeDeployData, http, parseAbi, parseEther,
  type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = resolve(import.meta.dirname, '..');
const configPath = resolve(root, process.env.VOID_DEX_CONFIG_FILE ?? 'lib/deployment.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.faucet) throw Error(`Faucet already deployed: ${config.faucet}`);
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw Error('DEPLOYER_PRIVATE_KEY is required');
const account = privateKeyToAccount(key as Hex);
const rpcUrl = process.env.PARENT_RPC ?? 'https://robinhood-testnet.drpc.org';
const rpc = createPublicClient({ transport: http(rpcUrl) });
const wallet = createWalletClient({ account, transport: http(rpcUrl) });
if (await rpc.getChainId() !== 46630) throw Error('Testnet only');
const raw = JSON.parse(readFileSync(resolve(root, 'out/VoidDexTestFaucet.sol/VoidDexTestFaucet.json'), 'utf8'));
const artifact = { abi: raw.abi as Abi, bytecode: `0x${raw.bytecode.object}` as Hex };
const gas = (await rpc.getGasPrice()) * 3n;
const deployHash = await wallet.sendTransaction({
  account, chain: null,
  data: encodeDeployData({ ...artifact, args: [config.runtime, 1n, config.pools[0].asset, config.pools[1].asset, parseEther('10000')] }),
  maxFeePerGas: gas, maxPriorityFeePerGas: 0n,
});
const deployed = await rpc.waitForTransactionReceipt({ hash: deployHash });
if (deployed.status !== 'success' || !deployed.contractAddress) throw Error('Faucet implementation deployment failed');
const factoryAbi = parseAbi([
  'function publish(uint256 tokenId,address implementation,bytes initData,bytes32 salt) returns(address app)',
  'event AppPublished(uint256 indexed tokenId,address indexed app,address indexed publisher,address implementation,bytes32 salt)',
]);
const publishHash = await wallet.writeContract({
  account, chain: null, address: config.appFactory as Address, abi: factoryAbi, functionName: 'publish',
  args: [1n, deployed.contractAddress, '0x', `0x${Date.now().toString(16).padStart(64, '0')}`],
  maxFeePerGas: gas, maxPriorityFeePerGas: 0n,
});
const published = await rpc.waitForTransactionReceipt({ hash: publishHash });
if (published.status !== 'success') throw Error('Faucet publication failed');
let faucet: Address | undefined;
for (const log of published.logs) {
  if (log.address.toLowerCase() !== config.appFactory.toLowerCase()) continue;
  try {
    const decoded = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
    if (decoded.eventName === 'AppPublished') faucet = (decoded.args as any).app;
  } catch {}
}
if (!faucet) throw Error('Published faucet gateway not found');
config.faucet = faucet;
config.faucetImplementation = deployed.contractAddress;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Faucet gateway ${faucet}`);
