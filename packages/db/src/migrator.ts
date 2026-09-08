import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from 'pg';

/**
 * Forward-only migration runner.
 *
 * Two rules make this safe to run against an existing database, which the workspace prompt
 * requires: it never drops or truncates anything, and it refuses to proceed when an
 * already-applied migration's text has changed. There is no `db:reset` script in this
 * repository; destroying a database is a deliberate manual act, not a routine command.
 */

export interface MigrationFile {
  readonly version: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationStatus {
  readonly version: string;
  readonly applied: boolean;
  readonly checksumMatches: boolean | null;
}

const VERSION_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export function checksumOf(sql: string): string {
  return `sha256:${createHash('sha256').update(sql, 'utf8').digest('hex')}`;
}

export async function loadMigrations(directory: string): Promise<readonly MigrationFile[]> {
  const entries = (await readdir(directory)).filter((name) => VERSION_PATTERN.test(name)).sort();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const sql = await readFile(path.join(directory, name), 'utf8');
    files.push({ version: name.replace(/\.sql$/, ''), checksum: checksumOf(sql), sql });
  }
  return files;
}

async function ensureBookkeeping(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT        NOT NULL PRIMARY KEY,
      checksum   TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT        NOT NULL,
      build_id   TEXT        NOT NULL
    )
  `);
}

async function appliedMigrations(client: Client): Promise<ReadonlyMap<string, string>> {
  const result = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

export async function migrationStatus(
  client: Client,
  files: readonly MigrationFile[],
): Promise<readonly MigrationStatus[]> {
  await ensureBookkeeping(client);
  const applied = await appliedMigrations(client);
  return files.map((file) => {
    const recorded = applied.get(file.version);
    return {
      version: file.version,
      applied: recorded !== undefined,
      checksumMatches: recorded === undefined ? null : recorded === file.checksum,
    };
  });
}

export class MigrationChecksumMismatch extends Error {
  constructor(version: string) {
    super(
      `migration ${version} was already applied with different SQL text. Migrations are ` +
        'immutable once applied; add a new forward migration instead of editing this one.',
    );
    this.name = 'MigrationChecksumMismatch';
  }
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export async function migrate(
  client: Client,
  files: readonly MigrationFile[],
  context: { readonly appliedBy: string; readonly buildId: string },
): Promise<MigrateResult> {
  await ensureBookkeeping(client);
  const existing = await appliedMigrations(client);

  for (const file of files) {
    const recorded = existing.get(file.version);
    if (recorded !== undefined && recorded !== file.checksum) {
      throw new MigrationChecksumMismatch(file.version);
    }
  }

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    if (existing.has(file.version)) {
      alreadyApplied.push(file.version);
      continue;
    }
    // Each migration is its own transaction: a failure leaves earlier migrations applied
    // and recorded, and never leaves a half-applied version marked complete.
    await client.query('BEGIN');
    try {
      await client.query(file.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum, applied_by, build_id) VALUES ($1,$2,$3,$4)',
        [file.version, file.checksum, context.appliedBy, context.buildId],
      );
      await client.query('COMMIT');
      applied.push(file.version);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  return { applied, alreadyApplied };
}
