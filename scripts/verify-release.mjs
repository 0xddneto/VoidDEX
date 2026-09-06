import fs from 'node:fs';

const deployment = JSON.parse(fs.readFileSync(new URL('../lib/deployment-v11-hardened.json', import.meta.url)));
const proxy = fs.readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8');
if (deployment.version !== 'v11-definitive-chainapp-testnet'
  || deployment.chainId !== 46630
  || deployment.deployBlock !== 113707579
  || deployment.deploymentId !== `${deployment.chainId}:${deployment.deployBlock}`
  || deployment.manifestHash !== '0x3ffc69e1e10352903ff4d43c3a5387d7c4a5dce5fc72dc891d063772f816098e'
  || deployment.releaseId !== `${deployment.chainId}:${deployment.deployBlock}:${deployment.manifestHash}`
  || deployment.initialPolicyHash !== '0x01b046d3334adb6ad849128fc3d7825135a4a604fd8cd3e183b853956fba5971'
  || deployment.signingOrigin !== 'https://www.voidchains.app') {
  throw new Error('VoidDEX is not locked to the accepted VoidScan release.');
}
if (!proxy.includes("const CANONICAL_HOST = 'voiddex-alpha.vercel.app'")) throw new Error('VoidDEX signing host is not canonical.');
console.log('VoidDEX is locked to the accepted VoidScan release.');
