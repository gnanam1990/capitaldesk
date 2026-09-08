import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildScenarioManifest } from './manifest.js';
import { SCENARIOS, runDeterministicScenario } from './scenarios.js';

function valueOf(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const output = valueOf('--output');
const commit = valueOf('--commit');
if (output === null || commit === null) {
  process.stderr.write('usage: scenario --output FILE --commit GIT_SHA [--seed VALUE]\n');
  process.exitCode = 2;
} else {
  const schemaVersions = (await readdir(new URL('../../db/migrations/', import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const manifest = buildScenarioManifest({
    commit,
    schemaVersions,
    mode: 'local-fixture',
    accountAlias: 'deterministic-fixture',
    epoch: '1',
    seed: valueOf('--seed') ?? '20260908',
    faultBoundary: 'independent-pure-model',
    actualIds: Object.fromEntries(
      SCENARIOS.map((scenario) => [
        scenario,
        `fixture:${scenario}:${valueOf('--seed') ?? '20260908'}`,
      ]),
    ),
    results: SCENARIOS.map(runDeterministicScenario),
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  process.stdout.write(`${manifest.digest}\t${output}\n`);
}
