/** Verifies every contract owned by the definitive Chain #1 DEX release. */
import { readFileSync } from 'node:fs';
import { createPublicClient, encodeAbiParameters, http, parseAbiParameters } from 'viem';

const deployment = JSON.parse(readFileSync('lib/deployment-v11-hardened.json', 'utf8'));
const exactInput = JSON.parse(readFileSync('out/standard-input.json', 'utf8'));
const explorer = 'https://explorer.testnet.chain.robinhood.com';
const rpc = createPublicClient({ transport: http('https://robinhood-testnet.drpc.org') });

async function record(address: string) {
  const response = await fetch(`${explorer}/api/v2/addresses/${address}`);
  if (!response.ok) throw Error(`Explorer read failed for ${address}`);
  return response.json() as Promise<{ is_verified?: boolean }>;
}
async function status(guid: string) {
  const response = await fetch(`${explorer}/api?module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}`);
  return ((await response.json()) as { result?: string }).result ?? 'Unknown';
}
async function submit(label: string, address: string, contractName: string, constructorArgs: string) {
  if ((await record(address)).is_verified) return console.log(`verified ${label}`);
  const source = contractName.split(':')[0]!;
  const body = new URLSearchParams({
    module: 'contract', action: 'verifysourcecode', codeformat: 'solidity-standard-json-input',
    contractaddress: address, contractname: contractName,
    compilerversion: 'v0.8.28+commit.7893614a', sourceCode: JSON.stringify(exactInput),
    constructorArguements: constructorArgs,
  });
  const response = await fetch(`${explorer}/api`, { method: 'POST', body });
  const result = await response.json() as { status?: string; result?: string };
  if (!response.ok || (result.status !== '1' && !/already verified/i.test(result.result ?? ''))) {
    throw Error(`Verification rejected for ${label}: ${JSON.stringify(result)}`);
  }
  if (result.status === '1') {
    for (let attempt = 0; attempt < 40 && !(await record(address)).is_verified; ++attempt) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const state = await status(result.result!);
      if (/fail|unable|error/i.test(state)) throw Error(`${label} verification failed: ${state}`);
    }
  }
  if (!(await record(address)).is_verified) throw Error(`${label} verification timed out`);
  console.log(`verified ${label}`);
}
async function topLevel(label: string, address: string, contractName: string) {
  if ((await record(address)).is_verified) return console.log(`verified ${label}`);
  const transaction = await rpc.getTransaction({ hash: deployment.steps[`deploy:${label}`] });
  const [source, name] = contractName.split(':');
  const artifact = JSON.parse(readFileSync(`out/${source.split('/').at(-1)}/${name}.json`, 'utf8'));
  const creation = artifact.bytecode.object as string;
  const input = transaction.input.slice(2);
  if (!input.startsWith(creation)) throw Error(`${label} creation bytecode mismatch`);
  await submit(label, address, contractName, input.slice(creation.length));
}

if (await rpc.getChainId() !== 46_630) throw Error('Robinhood testnet only');
await topLevel('tUsd', deployment.assets.tUsd, 'contracts/VoidDexTestTokenV11.sol:VoidDexTestTokenV11');
await topLevel('tLink', deployment.assets.tLink, 'contracts/VoidDexTestTokenV11.sol:VoidDexTestTokenV11');
await topLevel('implementation', deployment.implementation, 'contracts/VoidDexV11.sol:VoidDexV11');
for (const [index, pool] of deployment.pools.entries()) {
  const args = encodeAbiParameters(
    parseAbiParameters('address controller, address token0, address token1'),
    [deployment.app, pool.token0, pool.token1],
  ).slice(2);
  await submit(`pool ${index + 1}`, pool.address, 'contracts/VoidDexPairV11.sol:VoidDexPairV11', args);
}
console.log('PASS: DEX implementation, both test assets and both internal pools verified.');
