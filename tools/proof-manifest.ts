import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const PROOF_MANIFEST_SCHEMA = 'capitaldesk-proof-v1' as const;

export type ProofClass =
  'unit' | 'property' | 'postgresql' | 'process' | 'browser' | 'mutation' | 'venue' | 'document';

export interface ProofDescriptorArtifact {
  readonly path: string;
  readonly proofClass: ProofClass;
  readonly scenarios: readonly string[];
  readonly description: string;
  /** Only passing artifacts contribute release coverage. Failed runs remain in the bundle. */
  readonly result: 'PASS' | 'FAIL';
  /** True only when this file records an actually exercised boundary. */
  readonly actualBoundary: boolean;
}

export interface ProofDescriptor {
  readonly buildId: string;
  readonly mode: 'local' | 'testnet' | 'production';
  readonly accountAlias: string | null;
  readonly stableAccountIdDigest: string | null;
  readonly epoch: string | null;
  readonly adapterMode: string;
  readonly feePolicyVersion: string;
  readonly artifacts: readonly ProofDescriptorArtifact[];
  readonly limitations: readonly string[];
}

export interface ProofManifestArtifact extends ProofDescriptorArtifact {
  readonly sha256: string;
  readonly bytes: string;
}

export interface ProofManifest {
  readonly schema: typeof PROOF_MANIFEST_SCHEMA;
  readonly generatedAt: string;
  readonly build: {
    readonly id: string;
    readonly commit: string;
    readonly clean: boolean;
    readonly lockfileSha256: string;
    readonly testPlanSha256: string;
    readonly migrations: readonly string[];
  };
  readonly environment: {
    readonly mode: ProofDescriptor['mode'];
    readonly accountAlias: string | null;
    readonly stableAccountIdDigest: string | null;
    readonly epoch: string | null;
    readonly adapterMode: string;
    readonly feePolicyVersion: string;
  };
  readonly artifacts: readonly ProofManifestArtifact[];
  readonly limitations: readonly string[];
}

export interface ManifestVerification {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface ReleaseDecision {
  readonly decision: 'PASS' | 'FAIL';
  readonly errors: readonly string[];
  readonly coveredScenarios: readonly string[];
  readonly missingScenarios: readonly string[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_TAGGED = /^sha256:[0-9a-f]{64}$/;
const SCENARIO = /^T-[0-9]{3}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MIGRATION = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /\b(?=[A-Za-z0-9]{64}\b)(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{64}\b/,
];

const CLASS_REQUIREMENTS: Readonly<Record<string, readonly ProofClass[]>> = Object.freeze({
  'T-013': ['postgresql'],
  'T-014': ['postgresql'],
  'T-021': ['postgresql'],
  'T-026': ['venue'],
  'T-030': ['postgresql'],
  'T-031': ['postgresql'],
  'T-032': ['postgresql'],
  'T-033': ['postgresql'],
  'T-035': ['postgresql'],
  'T-036': ['process'],
  'T-037': ['process'],
  'T-044': ['process'],
  'T-045': ['venue', 'browser'],
  'T-046': ['browser'],
  'T-047': ['browser'],
  'T-048': ['browser'],
  'T-049': ['browser'],
  'T-050': ['browser'],
  'T-051': ['postgresql'],
  'T-052': ['mutation'],
  'T-053': ['venue'],
  'T-056': ['postgresql'],
  'T-059': ['postgresql'],
  'T-060': ['postgresql'],
  'T-065': ['postgresql'],
  'T-068': ['postgresql'],
});

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertDescriptor(descriptor: ProofDescriptor): void {
  if (descriptor.buildId.trim().length === 0) throw new Error('buildId is required');
  if (descriptor.adapterMode.trim().length === 0) throw new Error('adapterMode is required');
  if (descriptor.feePolicyVersion.trim().length === 0)
    throw new Error('feePolicyVersion is required');
  if (descriptor.mode === 'testnet') {
    if (descriptor.accountAlias === null || descriptor.accountAlias.trim().length === 0) {
      throw new Error('testnet proof requires a nonsecret account alias');
    }
    if (
      descriptor.stableAccountIdDigest === null ||
      !SHA256_TAGGED.test(descriptor.stableAccountIdDigest)
    ) {
      throw new Error('testnet proof requires a sha256 stable-account identity digest');
    }
    if (descriptor.epoch === null || !/^[1-9][0-9]*$/.test(descriptor.epoch)) {
      throw new Error('testnet proof requires a positive epoch string');
    }
  }
  const paths = new Set<string>();
  for (const artifact of descriptor.artifacts) {
    if (
      artifact.path.length === 0 ||
      path.isAbsolute(artifact.path) ||
      artifact.path.includes('..')
    ) {
      throw new Error(`artifact path must stay inside the bundle: ${artifact.path}`);
    }
    if (paths.has(artifact.path)) throw new Error(`duplicate artifact path: ${artifact.path}`);
    paths.add(artifact.path);
    if (artifact.description.trim().length === 0) {
      throw new Error(`artifact description is required: ${artifact.path}`);
    }
    if (artifact.result !== 'PASS' && artifact.result !== 'FAIL') {
      throw new Error(`artifact result is invalid: ${artifact.path}`);
    }
    if (artifact.scenarios.length === 0) throw new Error(`${artifact.path} names no scenario`);
    for (const scenario of artifact.scenarios) {
      if (!SCENARIO.test(scenario)) throw new Error(`invalid scenario id ${scenario}`);
    }
    if (artifact.proofClass === 'venue') {
      if (descriptor.mode !== 'testnet' || !artifact.actualBoundary) {
        throw new Error('venue evidence must be an actual testnet boundary');
      }
    }
  }
}

async function repositoryFile(root: string, relative: string): Promise<string> {
  const absoluteRoot = await realpath(root);
  const absolute = await realpath(path.join(absoluteRoot, relative));
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`artifact escapes repository: ${relative}`);
  }
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`artifact is not a regular file: ${relative}`);
  return absolute;
}

async function repositoryState(root: string): Promise<{ commit: string; clean: boolean }> {
  const [commit, status] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: root }),
    run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root }),
  ]);
  const value = commit.stdout.trim();
  if (!COMMIT.test(value)) throw new Error('git HEAD is not a full commit id');
  return { commit: value, clean: status.stdout.length === 0 };
}

export function testPlanScenarioIds(testPlan: string): readonly string[] {
  return [
    ...new Set([...testPlan.matchAll(/^### (T-[0-9]{3})\s/gm)].map((match) => match[1] ?? '')),
  ]
    .filter((value) => SCENARIO.test(value))
    .sort();
}

export async function createProofManifest(
  root: string,
  descriptor: ProofDescriptor,
  generatedAt = new Date().toISOString(),
): Promise<ProofManifest> {
  assertDescriptor(descriptor);
  const state = await repositoryState(root);
  const [lockfile, testPlan, migrationNames] = await Promise.all([
    readFile(await repositoryFile(root, 'pnpm-lock.yaml')),
    readFile(await repositoryFile(root, 'specs/capitaldesk/TEST-PLAN.md')),
    run('git', ['ls-files', 'packages/db/migrations/*.sql'], { cwd: root }),
  ]);
  const artifacts: ProofManifestArtifact[] = [];
  for (const artifact of [...descriptor.artifacts].sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = await readFile(await repositoryFile(root, artifact.path));
    const text = bytes.toString('utf8');
    if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new Error(`artifact contains credential-shaped material: ${artifact.path}`);
    }
    artifacts.push({ ...artifact, sha256: sha256(bytes), bytes: bytes.byteLength.toString() });
  }
  const migrations = migrationNames.stdout
    .trim()
    .split('\n')
    .map((file) => path.basename(file))
    .filter((file) => MIGRATION.test(file))
    .sort();
  return {
    schema: PROOF_MANIFEST_SCHEMA,
    generatedAt,
    build: {
      id: descriptor.buildId,
      commit: state.commit,
      clean: state.clean,
      lockfileSha256: sha256(lockfile),
      testPlanSha256: sha256(testPlan),
      migrations,
    },
    environment: {
      mode: descriptor.mode,
      accountAlias: descriptor.accountAlias,
      stableAccountIdDigest: descriptor.stableAccountIdDigest,
      epoch: descriptor.epoch,
      adapterMode: descriptor.adapterMode,
      feePolicyVersion: descriptor.feePolicyVersion,
    },
    artifacts,
    limitations: [...descriptor.limitations],
  };
}

export async function verifyProofManifest(
  root: string,
  manifest: ProofManifest,
): Promise<ManifestVerification> {
  const errors: string[] = [];
  if (manifest.schema !== PROOF_MANIFEST_SCHEMA) errors.push('manifest schema is unsupported');
  if (!COMMIT.test(manifest.build.commit)) errors.push('manifest commit is malformed');
  try {
    assertDescriptor({
      buildId: manifest.build.id,
      mode: manifest.environment.mode,
      accountAlias: manifest.environment.accountAlias,
      stableAccountIdDigest: manifest.environment.stableAccountIdDigest,
      epoch: manifest.environment.epoch,
      adapterMode: manifest.environment.adapterMode,
      feePolicyVersion: manifest.environment.feePolicyVersion,
      artifacts: manifest.artifacts,
      limitations: manifest.limitations,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const state = await repositoryState(root);
  if (state.commit !== manifest.build.commit) errors.push('manifest commit is stale');
  if (!state.clean || !manifest.build.clean) errors.push('proof is not bound to a clean checkout');
  const [lockfile, testPlan, migrationNames] = await Promise.all([
    readFile(await repositoryFile(root, 'pnpm-lock.yaml')),
    readFile(await repositoryFile(root, 'specs/capitaldesk/TEST-PLAN.md')),
    run('git', ['ls-files', 'packages/db/migrations/*.sql'], { cwd: root }),
  ]);
  if (sha256(lockfile) !== manifest.build.lockfileSha256) errors.push('lockfile digest is stale');
  if (sha256(testPlan) !== manifest.build.testPlanSha256) errors.push('test-plan digest is stale');
  const migrations = migrationNames.stdout
    .trim()
    .split('\n')
    .map((file) => path.basename(file))
    .filter((file) => MIGRATION.test(file))
    .sort();
  if (JSON.stringify(migrations) !== JSON.stringify(manifest.build.migrations)) {
    errors.push('migration set is stale');
  }
  for (const artifact of manifest.artifacts) {
    try {
      const bytes = await readFile(await repositoryFile(root, artifact.path));
      if (!SHA256.test(artifact.sha256) || sha256(bytes) !== artifact.sha256) {
        errors.push(`artifact digest is stale: ${artifact.path}`);
      }
      if (bytes.byteLength.toString() !== artifact.bytes) {
        errors.push(`artifact size is stale: ${artifact.path}`);
      }
      if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(bytes.toString('utf8')))) {
        errors.push(`artifact contains credential-shaped material: ${artifact.path}`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { valid: errors.length === 0, errors };
}

export function evaluateRelease(
  manifest: ProofManifest,
  requiredScenarios: readonly string[],
  integrity: ManifestVerification,
): ReleaseDecision {
  const errors = [...integrity.errors];
  const classesByScenario = new Map<string, Set<ProofClass>>();
  for (const artifact of manifest.artifacts) {
    if (artifact.result !== 'PASS') continue;
    for (const scenario of artifact.scenarios) {
      const classes = classesByScenario.get(scenario) ?? new Set<ProofClass>();
      classes.add(artifact.proofClass);
      classesByScenario.set(scenario, classes);
    }
  }
  const missingScenarios = requiredScenarios.filter((scenario) => !classesByScenario.has(scenario));
  if (missingScenarios.length > 0)
    errors.push(`missing scenario evidence: ${missingScenarios.join(', ')}`);
  for (const scenario of requiredScenarios) {
    const needed = CLASS_REQUIREMENTS[scenario];
    if (needed === undefined) continue;
    const actual = classesByScenario.get(scenario) ?? new Set<ProofClass>();
    for (const proofClass of needed) {
      if (!actual.has(proofClass)) errors.push(`${scenario} requires ${proofClass} evidence`);
    }
  }
  if (manifest.environment.mode === 'production') {
    errors.push('production activation is outside the testnet release gate');
  }
  return {
    decision: errors.length === 0 ? 'PASS' : 'FAIL',
    errors,
    coveredScenarios: [...classesByScenario.keys()].sort(),
    missingScenarios,
  };
}
