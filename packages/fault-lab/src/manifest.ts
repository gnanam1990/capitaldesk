import { createHash } from 'node:crypto';
import type { ScenarioResult } from './scenarios.js';

export interface ScenarioManifestInput {
  readonly commit: string;
  readonly schemaVersions: readonly string[];
  readonly mode: 'local-fixture' | 'postgres-fixture' | 'real-testnet';
  readonly accountAlias: string;
  readonly epoch: string;
  readonly seed: string;
  readonly faultBoundary: string;
  readonly actualIds: Readonly<Record<string, string>>;
  readonly results: readonly ScenarioResult[];
}

export interface ScenarioManifest extends ScenarioManifestInput {
  readonly manifestVersion: 'capitaldesk-fault-proof/v1';
  readonly evidenceClass: 'DETERMINISTIC_FIXTURE' | 'POSTGRES_FIXTURE' | 'VENUE_OBSERVED_TESTNET';
  readonly digest: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('manifest contains an unsupported value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

export function buildScenarioManifest(input: ScenarioManifestInput): ScenarioManifest {
  if (!/^[0-9a-f]{7,64}$/.test(input.commit)) throw new Error('commit must be a git hex id');
  if (!/^[1-9][0-9]{0,9}$/.test(input.epoch))
    throw new Error('epoch must be a positive integer string');
  if (input.accountAlias.length === 0) throw new Error('account alias is required');
  const evidenceClass: ScenarioManifest['evidenceClass'] =
    input.mode === 'real-testnet'
      ? 'VENUE_OBSERVED_TESTNET'
      : input.mode === 'postgres-fixture'
        ? 'POSTGRES_FIXTURE'
        : 'DETERMINISTIC_FIXTURE';
  const unsigned = {
    manifestVersion: 'capitaldesk-fault-proof/v1' as const,
    evidenceClass,
    ...input,
  };
  return {
    ...unsigned,
    digest: `sha256:${createHash('sha256').update(canonical(unsigned)).digest('hex')}`,
  };
}

export function verifyScenarioManifest(manifest: ScenarioManifest): boolean {
  const { digest, ...unsigned } = manifest;
  return `sha256:${createHash('sha256').update(canonical(unsigned)).digest('hex')}` === digest;
}
