import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractsRoot = resolve(root, 'contracts');
const out = resolve(root, 'out');
const files = readdirSync(contractsRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sol'))
  .map((entry) => resolve(contractsRoot, entry.name));
const sources = Object.fromEntries(files.map((file) => [
  relative(root, file).replaceAll('\\', '/'), { content: readFileSync(file, 'utf8') },
]));
const input = {
  language: 'Solidity', sources,
  settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input))) as any;
const errors = (output.errors ?? []).filter((issue: any) => issue.severity === 'error');
if (errors.length) {
  for (const issue of errors) console.error(issue.formattedMessage);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'standard-input.json'), JSON.stringify(input));
for (const [source, contracts] of Object.entries(output.contracts) as Array<[string, Record<string, any>]>) {
  for (const [name, artifact] of Object.entries(contracts)) {
    const target = resolve(out, basename(source), `${name}.json`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({
      abi: artifact.abi, bytecode: { object: artifact.evm.bytecode.object },
      deployedBytecode: { object: artifact.evm.deployedBytecode.object }, metadata: artifact.metadata,
    }, null, 2));
  }
}
console.log(`Built ${Object.keys(output.contracts).length} VoidDEX source groups with ${solc.version()}.`);
