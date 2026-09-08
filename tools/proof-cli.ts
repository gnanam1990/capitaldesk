import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createProofManifest,
  evaluateRelease,
  testPlanScenarioIds,
  verifyProofManifest,
  type ProofDescriptor,
  type ProofManifest,
} from './proof-manifest.js';

function option(args: readonly string[], name: string): string {
  const at = args.indexOf(name);
  const value = at < 0 ? undefined : args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

function bundleManifest(args: readonly string[]): string {
  const bundle = option(args, '--bundle');
  return path.resolve(bundle, 'manifest.json');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (command === 'create') {
    const descriptorPath = path.resolve(option(args, '--descriptor'));
    const outputPath = path.resolve(option(args, '--out'));
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as ProofDescriptor;
    const manifest = await createProofManifest(root, descriptor);
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`proof manifest written: ${outputPath}\n`);
    return;
  }
  if (command === 'verify' || command === 'gate') {
    const manifestPath = bundleManifest(args);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProofManifest;
    const integrity = await verifyProofManifest(root, manifest);
    if (command === 'verify') {
      process.stdout.write(`${JSON.stringify(integrity, null, 2)}\n`);
      if (!integrity.valid) process.exitCode = 1;
      return;
    }
    const testPlan = await readFile(path.join(root, 'specs/capitaldesk/TEST-PLAN.md'), 'utf8');
    const decision = evaluateRelease(manifest, testPlanScenarioIds(testPlan), integrity);
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    if (decision.decision !== 'PASS') process.exitCode = 1;
    return;
  }
  throw new Error('usage: proof-cli.ts create|verify|gate');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
