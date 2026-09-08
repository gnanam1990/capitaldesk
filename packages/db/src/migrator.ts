import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from 'pg';

/**
 * Forward-only migration runner.
 *
 * Rules that make this safe against a database that already holds data: it never drops or
 * truncates anything, `status` never writes, and it refuses to proceed unless the applied
 * history is an exact prefix of the migrations this build ships. There is no `db:reset`
 * script; destroying a database stays a deliberate manual act.
 *
 * The prefix rule matters more than it first appears. Without it, an older build run against
 * a database migrated by a newer one sees only the versions it knows about, concludes there
 * is nothing to do, and proceeds against a schema it has never seen. Worse, a version deleted
 * from the tree stops being noticed at all. Both are silent, and both were possible before:
 * `migrate(client, [])` reported success against a database carrying an unknown applied
 * migration, and a lower-numbered version supplied afterwards was applied on top of it.
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

/** A divergence between the applied history and the migrations this build ships. */
export interface HistoryDivergence {
  readonly kind:
    /** Applied in the database, absent from this build. The build is older, or a file was deleted. */
    | 'APPLIED_NOT_SUPPLIED'
    /** Applied text differs from the supplied text for the same version. */
    | 'CHECKSUM_MISMATCH'
    /** The applied set is not a prefix: an earlier version is missing beneath a later one. */
    | 'NOT_A_PREFIX'
    /** The supplied manifest itself is malformed. */
    | 'DUPLICATE_SUPPLIED_VERSION';
  readonly version: string;
  readonly detail: string;
}

export interface StatusReport {
  readonly migrations: readonly MigrationStatus[];
  /** Applied versions this build does not ship, in order. */
  readonly appliedNotSupplied: readonly string[];
  readonly divergences: readonly HistoryDivergence[];
  /** False when the bookkeeping table does not exist yet. `status` never creates it. */
  readonly bookkeepingExists: boolean;
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

async function bookkeepingExists(client: Client): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );
  return result.rows[0]?.present === true;
}

/**
 * Applied migrations in application order. Read-only: callers may run this inside a
 * `BEGIN READ ONLY` transaction, and it returns an empty history rather than creating the
 * bookkeeping table when none exists.
 */
async function appliedMigrations(client: Client): Promise<ReadonlyMap<string, string>> {
  if (!(await bookkeepingExists(client))) return new Map();
  const result = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

/**
 * Compare the applied history against the migrations this build ships.
 *
 * The applied set must be an exact prefix of the supplied list. Anything else — a version
 * applied that this build does not ship, a gap beneath an applied version, a changed
 * checksum, a duplicate in the manifest — is a divergence, and divergences block migration
 * rather than being worked around.
 */
export function compareHistory(
  applied: ReadonlyMap<string, string>,
  files: readonly MigrationFile[],
): { divergences: readonly HistoryDivergence[]; appliedNotSupplied: readonly string[] } {
  const divergences: HistoryDivergence[] = [];

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.version)) {
      divergences.push({
        kind: 'DUPLICATE_SUPPLIED_VERSION',
        version: file.version,
        detail: 'the supplied migration list contains this version more than once',
      });
    }
    seen.add(file.version);
  }

  const supplied = new Set(files.map((file) => file.version));
  const appliedNotSupplied = [...applied.keys()].filter((version) => !supplied.has(version)).sort();
  for (const version of appliedNotSupplied) {
    divergences.push({
      kind: 'APPLIED_NOT_SUPPLIED',
      version,
      detail:
        'this version is applied in the database but is not shipped by this build. The build ' +
        'is older than the database, or the migration file was deleted.',
    });
  }

  // Prefix rule: once a supplied version is unapplied, no later supplied version may be
  // applied. A gap means the histories diverged rather than one being behind the other.
  let sawUnapplied: string | null = null;
  for (const file of files) {
    const recorded = applied.get(file.version);
    if (recorded === undefined) {
      sawUnapplied ??= file.version;
      continue;
    }
    if (recorded !== file.checksum) {
      divergences.push({
        kind: 'CHECKSUM_MISMATCH',
        version: file.version,
        detail:
          'this version was applied with different SQL text. Migrations are immutable once ' +
          'applied; add a new forward migration instead of editing this one.',
      });
    }
    if (sawUnapplied !== null) {
      divergences.push({
        kind: 'NOT_A_PREFIX',
        version: file.version,
        detail: `applied, but the earlier version ${sawUnapplied} is not applied`,
      });
    }
  }

  return { divergences, appliedNotSupplied };
}

/** Read-only status. Never writes, and never creates the bookkeeping table. */
export async function migrationStatus(
  client: Client,
  files: readonly MigrationFile[],
): Promise<StatusReport> {
  const exists = await bookkeepingExists(client);
  const applied = exists ? await appliedMigrations(client) : new Map<string, string>();
  const { divergences, appliedNotSupplied } = compareHistory(applied, files);

  return {
    bookkeepingExists: exists,
    appliedNotSupplied,
    divergences,
    migrations: files.map((file) => {
      const recorded = applied.get(file.version);
      return {
        version: file.version,
        applied: recorded !== undefined,
        checksumMatches: recorded === undefined ? null : recorded === file.checksum,
      };
    }),
  };
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

/** The applied history is not an exact prefix of what this build ships. */
export class MigrationHistoryDiverged extends Error {
  readonly divergences: readonly HistoryDivergence[];

  constructor(divergences: readonly HistoryDivergence[]) {
    super(
      'refusing to migrate: the applied history does not match the migrations this build ' +
        `ships.\n  - ${divergences.map((d) => `${d.version} (${d.kind}): ${d.detail}`).join('\n  - ')}`,
    );
    this.name = 'MigrationHistoryDiverged';
    this.divergences = divergences;
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
  // Read the existing history before creating anything, so a divergence is refused without
  // this build touching the database at all.
  const existing = await appliedMigrations(client);
  const { divergences } = compareHistory(existing, files);

  // A checksum mismatch keeps its own error type, because it has a specific remedy.
  const mismatch = divergences.find((d) => d.kind === 'CHECKSUM_MISMATCH');
  if (mismatch !== undefined) throw new MigrationChecksumMismatch(mismatch.version);
  if (divergences.length > 0) throw new MigrationHistoryDiverged(divergences);

  await ensureBookkeeping(client);

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
