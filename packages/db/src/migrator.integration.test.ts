import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MigrationChecksumMismatch,
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
    const status = await migrationStatus(client, files);
    expect(status.every((row) => !row.applied)).toBe(true);
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
    const status = await migrationStatus(client, edited);
    expect(status[0]?.checksumMatches).toBe(false);
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
