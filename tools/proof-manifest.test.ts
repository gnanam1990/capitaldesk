import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProofManifest,
  evaluateRelease,
  testPlanScenarioIds,
  verifyProofManifest,
  type ProofDescriptor,
} from './proof-manifest.js';

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'capitaldesk-proof-'));
  await mkdir(path.join(root, 'packages/db/migrations'), { recursive: true });
  await mkdir(path.join(root, 'specs/capitaldesk'), { recursive: true });
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: test\n');
  await writeFile(path.join(root, 'packages/db/migrations/0001_test.sql'), 'select 1;\n');
  await writeFile(
    path.join(root, 'specs/capitaldesk/TEST-PLAN.md'),
    '### T-001 — one\n### T-053 — venue\n',
  );
  await writeFile(path.join(root, 'evidence/result.json'), '{"passed":true}\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'proof@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Proof Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

const descriptor = (): ProofDescriptor => ({
  buildId: 'proof-test',
  mode: 'testnet',
  accountAlias: 'proof-account',
  stableAccountIdDigest: `sha256:${'a'.repeat(64)}`,
  epoch: '1',
  adapterMode: 'broker-key-testnet',
  feePolicyVersion: 'STANDARD_NO_BNB_V1',
  artifacts: [
    {
      path: 'evidence/result.json',
      proofClass: 'venue',
      scenarios: ['T-001', 'T-053'],
      description: 'fixture boundary',
      result: 'PASS',
      actualBoundary: true,
    },
  ],
  limitations: [],
});

describe('proof manifest', () => {
  it('binds files, commit, lockfile, migrations and test plan to a clean checkout', async () => {
    const root = await repository();
    const manifest = await createProofManifest(root, descriptor(), '2026-09-08T00:00:00.000Z');
    expect(manifest.build.clean).toBe(true);
    expect(manifest.artifacts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyProofManifest(root, manifest)).toEqual({ valid: true, errors: [] });
    await writeFile(path.join(root, 'evidence/result.json'), '{"passed":false}\n');
    expect((await verifyProofManifest(root, manifest)).errors).toContain(
      'artifact digest is stale: evidence/result.json',
    );
  });

  it('refuses to label a local fixture as venue evidence', async () => {
    const root = await repository();
    await expect(
      createProofManifest(root, { ...descriptor(), mode: 'local', accountAlias: null }),
    ).rejects.toThrow('venue evidence must be an actual testnet boundary');
  });

  it('fails the release decision when a required scenario or proof class is absent', async () => {
    const root = await repository();
    const manifest = await createProofManifest(root, descriptor());
    const decision = evaluateRelease(manifest, ['T-001', 'T-045', 'T-053'], {
      valid: true,
      errors: [],
    });
    expect(decision.decision).toBe('FAIL');
    expect(decision.missingScenarios).toEqual(['T-045']);
    expect(decision.errors).toContain('T-045 requires browser evidence');
  });

  it('does not trust a hand-edited local manifest or count a failed run as coverage', async () => {
    const root = await repository();
    const manifest = await createProofManifest(root, descriptor());
    const forged = {
      ...manifest,
      environment: { ...manifest.environment, mode: 'local' as const },
      artifacts: manifest.artifacts.map((artifact) => ({ ...artifact, result: 'FAIL' as const })),
    };
    expect((await verifyProofManifest(root, forged)).errors).toContain(
      'venue evidence must be an actual testnet boundary',
    );
    const decision = evaluateRelease(forged, ['T-001', 'T-053'], {
      valid: false,
      errors: ['venue evidence must be an actual testnet boundary'],
    });
    expect(decision.decision).toBe('FAIL');
    expect(decision.missingScenarios).toEqual(['T-001', 'T-053']);
  });

  it('extracts the authoritative scenario set from headings', () => {
    expect(testPlanScenarioIds('### T-010 — a\ntext\n### T-002 — b\n### T-010 — repeated')).toEqual(
      ['T-002', 'T-010'],
    );
  });
});
