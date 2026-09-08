import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MigrationChecksumMismatch,
  MigrationHistoryDiverged,
  checksumOf,
  loadMigrations,
  migrate,
  migrationStatus,
  type MigrationFile,
} from './migrator.js';

/**
 * Integration evidence: a real PostgreSQL server, not a mock.
 *
 * Skipped with a visible reason when CAPITALDESK_TEST_DATABASE_URL is absent, so an
 * environment without a database reports missing coverage instead of counting these
 * assertions as passed (TEST-PLAN section 1, evidence classes).
 */
const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

describeIfDatabase('migration runner against real PostgreSQL', () => {
  let client: Client;
  let schema: string;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeAll(() => {
    schema = `cd_test_${Date.now()}`;
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  });

  beforeAll(async () => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  });

  it('reports the shipped migrations as pending on an empty database', async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);
    const report = await migrationStatus(client, files);
    expect(report.migrations.every((row) => !row.applied)).toBe(true);
    expect(report.bookkeepingExists).toBe(false);
  });

  // --- regression: maintainer review, status wrote to the database ---------------------
  // migrationStatus created the bookkeeping table, so a command documented as reporting
  // without writing failed with 25006 inside a READ ONLY transaction, and silently wrote
  // outside one.
  describe('status never writes (regression: draft review)', () => {
    it('runs inside a READ ONLY transaction on a database with no bookkeeping table', async () => {
      await client.query('BEGIN READ ONLY');
      try {
        const report = await migrationStatus(client, await loadMigrations(MIGRATIONS_DIR));
        expect(report.bookkeepingExists).toBe(false);
        expect(report.migrations.every((row) => !row.applied)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }
    });

    it('does not create the bookkeeping table as a side effect', async () => {
      await migrationStatus(client, await loadMigrations(MIGRATIONS_DIR));
      const exists = await client.query<{ present: boolean }>(
        "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
      );
      expect(exists.rows[0]?.present).toBe(false);
    });

    it('runs read-only after migrations have been applied', async () => {
      const files = await loadMigrations(MIGRATIONS_DIR);
      await migrate(client, files, { appliedBy: 'vitest', buildId: 'b1' });
      await client.query('BEGIN READ ONLY');
      try {
        const report = await migrationStatus(client, files);
        expect(report.bookkeepingExists).toBe(true);
        expect(report.migrations.every((row) => row.applied)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  // --- regression: maintainer review, divergent history accepted silently --------------
  // After applying 0002_newer, migrationStatus(client, []) returned [] and migrate(client, [])
  // reported success. Supplying only 0001_earlier afterwards then applied it on top of an
  // unknown newer migration. An older build could proceed against a schema it had never seen.
  describe('divergent applied history (regression: draft review)', () => {
    const newerSql = 'CREATE TABLE newer_contract(id int primary key)';
    const newer: MigrationFile = {
      version: '0002_newer',
      sql: newerSql,
      checksum: checksumOf(newerSql),
    };
    const earlierSql = 'CREATE TABLE late_lower_version(id int)';
    const earlier: MigrationFile = {
      version: '0001_earlier',
      sql: earlierSql,
      checksum: checksumOf(earlierSql),
    };

    async function applyNewer(): Promise<void> {
      await migrate(client, [newer], { appliedBy: 'vitest', buildId: 'newer' });
    }

    it('reports an applied version this build does not ship', async () => {
      await applyNewer();
      const report = await migrationStatus(client, []);
      expect(report.appliedNotSupplied).toEqual(['0002_newer']);
      expect(report.divergences.map((d) => d.kind)).toContain('APPLIED_NOT_SUPPLIED');
    });

    it('refuses to migrate an empty manifest against an unknown applied migration', async () => {
      await applyNewer();
      await expect(
        migrate(client, [], { appliedBy: 'vitest', buildId: 'older' }),
      ).rejects.toBeInstanceOf(MigrationHistoryDiverged);
    });

    it('refuses a lower-numbered migration supplied after an unknown newer one', async () => {
      await applyNewer();
      await expect(
        migrate(client, [earlier], { appliedBy: 'vitest', buildId: 'diverged' }),
      ).rejects.toBeInstanceOf(MigrationHistoryDiverged);
    });

    it('does not apply anything when it refuses', async () => {
      await applyNewer();
      await expect(
        migrate(client, [earlier], { appliedBy: 'vitest', buildId: 'diverged' }),
      ).rejects.toThrow();
      const table = await client.query<{ present: boolean }>(
        "SELECT to_regclass('late_lower_version') IS NOT NULL AS present",
      );
      expect(table.rows[0]?.present).toBe(false);
    });

    it('refuses when an earlier version is missing beneath an applied later one', async () => {
      await applyNewer();
      // This build ships both, but only the later one is applied: not a prefix.
      await expect(
        migrate(client, [earlier, newer], { appliedBy: 'vitest', buildId: 'gap' }),
      ).rejects.toBeInstanceOf(MigrationHistoryDiverged);
    });

    it('names the missing earlier version in the divergence', async () => {
      await applyNewer();
      const report = await migrationStatus(client, [earlier, newer]);
      const notPrefix = report.divergences.find((d) => d.kind === 'NOT_A_PREFIX');
      expect(notPrefix?.version).toBe('0002_newer');
      expect(notPrefix?.detail).toContain('0001_earlier');
    });

    it('refuses a manifest containing a duplicate version', async () => {
      await expect(
        migrate(client, [earlier, earlier], { appliedBy: 'vitest', buildId: 'dupe' }),
      ).rejects.toBeInstanceOf(MigrationHistoryDiverged);
    });

    it('still applies a normal contiguous manifest', async () => {
      const result = await migrate(client, [earlier, newer], {
        appliedBy: 'vitest',
        buildId: 'ordered',
      });
      expect(result.applied).toEqual(['0001_earlier', '0002_newer']);
      const again = await migrate(client, [earlier, newer], {
        appliedBy: 'vitest',
        buildId: 'ordered',
      });
      expect(again.applied).toEqual([]);
      expect(again.alreadyApplied).toEqual(['0001_earlier', '0002_newer']);
    });
  });

  it('applies pending migrations and records who applied them', async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    const result = await migrate(client, files, { appliedBy: 'vitest', buildId: 'test-build' });
    expect(result.applied).toEqual(files.map((file) => file.version));

    const recorded = await client.query<{ version: string; applied_by: string; build_id: string }>(
      'SELECT version, applied_by, build_id FROM schema_migrations ORDER BY version',
    );
    expect(recorded.rows[0]?.applied_by).toBe('vitest');
    expect(recorded.rows[0]?.build_id).toBe('test-build');
  });

  it('is idempotent: a second run applies nothing', async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    await migrate(client, files, { appliedBy: 'vitest', buildId: 'b1' });
    const second = await migrate(client, files, { appliedBy: 'vitest', buildId: 'b2' });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(files.map((file) => file.version));
  });

  it('refuses to reapply a migration whose SQL text changed after it was applied', async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    await migrate(client, files, { appliedBy: 'vitest', buildId: 'b1' });

    const edited: MigrationFile[] = files.map((file, index) =>
      index === 0
        ? { ...file, sql: `${file.sql}\n-- edited`, checksum: checksumOf(`${file.sql}\n-- edited`) }
        : file,
    );
    await expect(
      migrate(client, edited, { appliedBy: 'vitest', buildId: 'b2' }),
    ).rejects.toBeInstanceOf(MigrationChecksumMismatch);
  });

  it('reports a checksum mismatch in status without writing anything', async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    await migrate(client, files, { appliedBy: 'vitest', buildId: 'b1' });
    const edited = files.map((file, index) =>
      index === 0 ? { ...file, checksum: 'sha256:different' } : file,
    );
    const report = await migrationStatus(client, edited);
    expect(report.migrations[0]?.checksumMatches).toBe(false);
    expect(report.divergences.map((d) => d.kind)).toContain('CHECKSUM_MISMATCH');
  });

  it('leaves an existing table untouched: migrating is never destructive', async () => {
    await client.query('CREATE TABLE pre_existing (id int primary key)');
    await client.query('INSERT INTO pre_existing VALUES (42)');

    const files = await loadMigrations(MIGRATIONS_DIR);
    await migrate(client, files, { appliedBy: 'vitest', buildId: 'b1' });

    const rows = await client.query<{ id: number }>('SELECT id FROM pre_existing');
    expect(rows.rows).toEqual([{ id: 42 }]);
  });

  it('rolls a failing migration back and does not record it as applied', async () => {
    const broken: MigrationFile[] = [
      {
        version: '9001_broken',
        sql: 'CREATE TABLE ok_first (id int); SELECT 1/0;',
        checksum: 'sha256:x',
      },
    ];
    await expect(migrate(client, broken, { appliedBy: 'vitest', buildId: 'b1' })).rejects.toThrow();

    const applied = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schema_migrations WHERE version = '9001_broken'",
    );
    expect(applied.rows[0]?.count).toBe('0');

    const table = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM information_schema.tables ' +
        `WHERE table_schema = '${schema}' AND table_name = 'ok_first'`,
    );
    expect(table.rows[0]?.count).toBe('0');
  });
});
