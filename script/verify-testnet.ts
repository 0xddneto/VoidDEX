/** Verify every VoidDEX implementation while treating gateways as inspected proxies. */
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, getAddress, parseAbiParameters, type Address } from 'viem';

const explorer = 'https://explorer.testnet.chain.robinhood.com';
const input = readFileSync('out/standard-input.json', 'utf8');
const deployment = JSON.parse(readFileSync('lib/deployment.json', 'utf8'));
const e18 = 10n ** 18n;

type Target = { label: string; address: Address; contract: string; args: `0x${string}` };
const abiArgs = (types: string, values: readonly unknown[]) =>
  encodeAbiParameters(parseAbiParameters(types), values as never);

async function addressRecord(address: Address) {
  const response = await fetch(`${explorer}/api/v2/addresses/${address}`);
  if (!response.ok) throw new Error(`Explorer read failed for ${address}: ${response.status}`);
  return response.json() as Promise<{ is_verified?: boolean; implementations?: Array<{ address_hash: string }> }>;
}

const gatewayImplementations = new Map<string, Address>();
for (const gateway of [deployment.factory, ...deployment.pools.map((pool: { address: Address }) => pool.address), deployment.faucet] as Address[]) {
  const record = await addressRecord(gateway);
  const implementation = record.implementations?.[0]?.address_hash;
  if (!implementation) throw new Error(`Gateway ${gateway} is not linked to an implementation by the explorer.`);
  gatewayImplementations.set(gateway.toLowerCase(), getAddress(implementation));
}

const factoryImplementation = gatewayImplementations.get(deployment.factory.toLowerCase())!;
const faucetImplementation = gatewayImplementations.get(deployment.faucet.toLowerCase())!;
const targets: Target[] = [
  { label: 'tUSD', address: getAddress(deployment.pools[0].asset), contract: 'contracts/TestToken.sol:TestToken', args: abiArgs('string,string,uint256', ['Void Test Dollar', 'tUSD', 5_000_000n * e18]) },
  { label: 'tLINK', address: getAddress(deployment.pools[1].asset), contract: 'contracts/TestToken.sol:TestToken', args: abiArgs('string,string,uint256', ['Void Test Link', 'tLINK', 5_000_000n * e18]) },
  { label: 'factory implementation', address: factoryImplementation, contract: 'contracts/VoidChainDexFactoryV4.sol:VoidChainDexFactoryV4', args: abiArgs('address,uint256,address', [deployment.runtime, 1n, deployment.appFactory]) },
  { label: 'faucet implementation', address: faucetImplementation, contract: 'contracts/VoidDexTestFaucet.sol:VoidDexTestFaucet', args: abiArgs('address,uint256,address,address,uint256', [deployment.runtime, 1n, deployment.pools[0].asset, deployment.pools[1].asset, 10_000n * e18]) },
  ...deployment.pools.map((pool: { address: Address; token0: Address; token1: Address; label: string }) => ({
    label: `${pool.label} implementation`,
    address: gatewayImplementations.get(pool.address.toLowerCase())!,
    contract: 'contracts/VoidUniswapV2Pair.sol:VoidUniswapV2Pair',
    args: abiArgs('address,uint256,address,address', [deployment.runtime, 1n, pool.token0, pool.token1]),
  })),
];

async function submit(target: Target) {
  if ((await addressRecord(target.address)).is_verified) return console.log(`verified ${target.label}`);
  const body = new URLSearchParams({
    module: 'contract', action: 'verifysourcecode', codeformat: 'solidity-standard-json-input',
    contractaddress: target.address, contractname: target.contract,
    compilerversion: 'v0.8.28+commit.7893614a', sourceCode: input,
    constructorArguements: target.args.slice(2),
  });
  const response = await fetch(`${explorer}/api`, { method: 'POST', body });
  const result = await response.json() as { status?: string; result?: string };
  if (/already verified/i.test(result.result ?? '')) return;
  if (!response.ok || result.status !== '1' || !result.result) throw new Error(`${target.label}: ${JSON.stringify(result)}`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    if ((await addressRecord(target.address)).is_verified) return console.log(`verified ${target.label}`);
    const status = await (await fetch(`${explorer}/api?module=contract&action=checkverifystatus&guid=${encodeURIComponent(result.result)}`)).json() as { result?: string };
    if (/fail|error|unable/i.test(status.result ?? '')) throw new Error(`${target.label}: ${status.result}`);
  }
  throw new Error(`Verification timed out for ${target.label}.`);
}

for (const target of targets) await submit(target);
console.log(`PASS: ${targets.length} VoidDEX implementations verified and ${gatewayImplementations.size} gateways linked.`);
