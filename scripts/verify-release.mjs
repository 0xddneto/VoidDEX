import fs from 'node:fs';

const deployment = JSON.parse(fs.readFileSync(new URL('../lib/deployment-v11-hardened.json', import.meta.url)));
const proxy = fs.readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8');
if (deployment.version !== 'v11-definitive-chainapp-testnet'
  || deployment.chainId !== 46630
  || deployment.deployBlock !== 113707579
  || deployment.deploymentId !== `${deployment.chainId}:${deployment.deployBlock}`
  || deployment.manifestHash !== '0x5dd0790cb29c0661e3f748920a1e6a5cf47ba4ca63fd4610da2c846da651f46d'
  || deployment.releaseId !== `${deployment.chainId}:${deployment.deployBlock}:${deployment.manifestHash}`
  || deployment.initialPolicyHash !== '0x01b046d3334adb6ad849128fc3d7825135a4a604fd8cd3e183b853956fba5971'
  || deployment.signingOrigin !== 'https://www.voidchains.app') {
  throw new Error('VoidDEX is not locked to the accepted VoidScan release.');
}
if (!proxy.includes("const CANONICAL_HOST = 'voiddex-alpha.vercel.app'")) throw new Error('VoidDEX signing host is not canonical.');
console.log('VoidDEX is locked to the accepted VoidScan release.');
