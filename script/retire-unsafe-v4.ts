/** One-time testnet cleanup after the balance-delta V4 pool replacement. */
import 'dotenv/config';
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const runtime = '0x67fe2acba322f2d031dc79fd4dde997bd1ec9dae' as Address;
const retired = [
  '0x0AE6f2223B26Eb007Ac4E1fe9bF26427Ad72B159',
  '0x57bB44d355daDE1dE9F8307314FFa1b2388f8A38',
  '0xAD3618dC4BE9E06162e7bd479Af5ad546850c926',
  '0x67F277F13C5A6267C777e4E251cABdda86D9A366',
] as Address[];
const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Missing testnet deployer key');
const account = privateKeyToAccount(key);
const transport = http(process.env.PARENT_RPC ?? 'https://rpc.testnet.chain.robinhood.com');
const rpc = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport });
if (await rpc.getChainId() !== 46_630) throw new Error('Testnet only');
const abi = parseAbi([
  'function belongsTo(uint256,address) view returns(bool)',
  'function publisherOf(uint256,address) view returns(address)',
  'function unregisterApp(uint256,address)',
]);
for (const app of retired) {
  if (!await rpc.readContract({ address: runtime, abi, functionName: 'belongsTo', args: [1n, app] })) continue;
  const publisher = await rpc.readContract({ address: runtime, abi, functionName: 'publisherOf', args: [1n, app] });
  if (publisher.toLowerCase() !== account.address.toLowerCase()) {
    console.warn(`cannot retire ${app}: publisher is ${publisher}`);
    continue;
  }
  const hash = await wallet.writeContract({ account, chain: null, address: runtime, abi, functionName: 'unregisterApp', args: [1n, app] });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Retirement reverted: ${app}`);
  console.log(`retired ${app} ${hash}`);
}
