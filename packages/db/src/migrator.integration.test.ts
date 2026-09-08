import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BookkeepingTableIncompatible,
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
    // The per-test reset below recreates the schema after dropping it, so without this the
    // last one outlived the run. Every suite leaves the database as it found it.
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
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

  /**
   * 0005 is the first migration that reshapes tables an already-running database holds. The
   * risk it carries is not syntax: it replaces `claim_balances`' primary key and adds a NOT
   * NULL epoch to a table that has rows. Getting that wrong on a populated database either
   * fails the upgrade or, worse, invents an epoch for balances that belong to another one.
   *
   * So the upgrade is exercised against the state it will actually meet: a pool that has been
   * through a reset, with postings on both sides of it.
   */
  describe('upgrading a populated database to the per-epoch projection', () => {
    const WORKSPACE = 'ws-upgrade';
    const POOL = 'pool-upgrade';

    /** A pool with epoch 1 closed by a reset, epoch 2 open, and postings in both. */
    async function seedRotatedHistory(): Promise<void> {
      await client.query(
        `INSERT INTO workspaces (workspace_id, display_name)
                          VALUES ($1, 'Upgrade')`,
        [WORKSPACE],
      );
      await client.query(
        `INSERT INTO venue_accounts (venue, environment, stable_account_id)
         VALUES ('binance-spot','local','acct-upgrade')`,
      );
      await client.query(
        `INSERT INTO pools (workspace_id, pool_id, venue, environment, stable_account_id,
                            state, ledger_revision)
         VALUES ($1,$2,'binance-spot','local','acct-upgrade','READY',2)`,
        [WORKSPACE, POOL],
      );
      await client.query(
        `INSERT INTO baseline_epochs (workspace_id, pool_id, epoch, closed_at, closed_reason)
         VALUES ($1,$2,1, now(), 'testnet reset'), ($1,$2,2, NULL, NULL)`,
        [WORKSPACE, POOL],
      );

      // Epoch 1 opened 1000 USDT; the reset closed it. Epoch 2 opened 400. Under the schema
      // being upgraded from, nothing on an entry records which of those it belongs to.
      for (const [epoch, txn, atoms, revision] of [
        [1, 'txn-epoch-1', '1000', 1],
        [2, 'txn-epoch-2', '400', 2],
      ] as const) {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO ledger_transactions
             (workspace_id, pool_id, epoch, ledger_txn_id, revision, source_kind, source_ref,
              description)
           VALUES ($1,$2,$3,$4,$5,'baseline',$4,'opening')`,
          [WORKSPACE, POOL, epoch, txn, revision],
        );
        await client.query(
          `INSERT INTO ledger_entries
             (workspace_id, pool_id, ledger_txn_id, entry_seq, account_kind, account_owner,
              claim_state, asset_code, asset_scale, delta_atoms)
           VALUES ($1,$2,$3,1,'ASSET_CONTROL','ASSET_CONTROL','CONTROL','USDT','v1',$4),
                  ($1,$2,$3,2,'HOUSE','HOUSE','AVAILABLE','USDT','v1',$4)`,
          [WORKSPACE, POOL, txn, atoms],
        );
        await client.query('COMMIT');
      }
      await client.query('SELECT rebuild_claim_balances($1,$2)', [WORKSPACE, POOL]);
    }

    async function houseClaims(): Promise<{ epoch: number | null; atoms: string }[]> {
      const hasEpoch = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = current_schema()
                           AND table_name = 'claim_balances' AND column_name = 'epoch') AS exists`,
      );
      const epochColumn = hasEpoch.rows[0]?.exists === true ? 'epoch' : 'NULL::integer AS epoch';
      const rows = await client.query<{ epoch: number | null; atoms: string }>(
        `SELECT ${epochColumn}, available_atoms::text AS atoms FROM claim_balances
          WHERE account_owner = 'HOUSE' ORDER BY 1`,
      );
      return rows.rows;
    }

    it('preserves every epoch’s own figures instead of guessing one', async () => {
      const files = await loadMigrations(MIGRATIONS_DIR);
      const before = files.filter((file) => file.version < '0005');
      expect(before.length).toBe(files.length - 1);

      await migrate(client, before, { appliedBy: 'vitest', buildId: 'pre-0005' });
      await seedRotatedHistory();

      // The state 0005 exists to correct: one row, both epochs summed into it, so a closed
      // epoch's 1000 was still spendable authority alongside the current epoch's 400.
      expect(await houseClaims()).toEqual([{ epoch: null, atoms: '1400' }]);

      // The upgrade itself must succeed against exactly this database.
      const result = await migrate(client, files, { appliedBy: 'vitest', buildId: 'to-0005' });
      expect(result.applied).toEqual(['0005_baseline']);

      // Both epochs survive, each with its own figures. Neither was dropped, and neither was
      // attributed to the other.
      expect(await houseClaims()).toEqual([
        { epoch: 1, atoms: '1000' },
        { epoch: 2, atoms: '400' },
      ]);

      // The entries kept their true epoch, taken from the transaction that posted them,
      // which is what makes the rebuilt view derived rather than invented.
      const entries = await client.query<{ epoch: number; txn: string }>(
        `SELECT DISTINCT epoch, ledger_txn_id AS txn FROM ledger_entries ORDER BY epoch`,
      );
      expect(entries.rows).toEqual([
        { epoch: 1, txn: 'txn-epoch-1' },
        { epoch: 2, txn: 'txn-epoch-2' },
      ]);
    });

    it('leaves ledger entries immutable again once the backfill is done', async () => {
      // The backfill suspends the append-only trigger. If it did not restore it, this
      // migration would silently make every posting rewritable from then on — a far worse
      // defect than the one it set out to fix.
      const files = await loadMigrations(MIGRATIONS_DIR);
      await migrate(
        client,
        files.filter((file) => file.version < '0005'),
        {
          appliedBy: 'vitest',
          buildId: 'pre-0005',
        },
      );
      await seedRotatedHistory();
      await migrate(client, files, { appliedBy: 'vitest', buildId: 'to-0005' });

      const enabled = await client.query<{ tgenabled: string }>(
        `SELECT tgenabled FROM pg_trigger
          WHERE tgname = 'ledger_entries_are_immutable'
            AND tgrelid = to_regclass(current_schema() || '.ledger_entries')`,
      );
      expect(enabled.rows[0]?.tgenabled).toBe('O');

      let refusal = 'accepted';
      try {
        await client.query(`UPDATE ledger_entries SET delta_atoms = 1 WHERE epoch = 2`);
      } catch (error) {
        refusal = (error as { message?: string }).message ?? 'unknown';
      }
      expect(refusal).toContain('append-only table ledger_entries');
    });

    it('leaves the closed epoch unable to fund the open one', async () => {
      // The point of the per-epoch projection is authority, not presentation. After the
      // upgrade the closed epoch's 1000 must not cover a withdrawal in epoch 2.
      const files = await loadMigrations(MIGRATIONS_DIR);
      await migrate(
        client,
        files.filter((file) => file.version < '0005'),
        {
          appliedBy: 'vitest',
          buildId: 'pre-0005',
        },
      );
      await seedRotatedHistory();
      await migrate(client, files, { appliedBy: 'vitest', buildId: 'to-0005' });

      let refusal = 'accepted';
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO ledger_transactions
             (workspace_id, pool_id, epoch, ledger_txn_id, revision, source_kind, source_ref,
              description)
           VALUES ($1,$2,2,'txn-overspend',3,'operator','overspend','spend across the reset')`,
          [WORKSPACE, POOL],
        );
        await client.query(
          `INSERT INTO ledger_entries
             (workspace_id, pool_id, epoch, ledger_txn_id, entry_seq, account_kind,
              account_owner, claim_state, asset_code, asset_scale, delta_atoms)
           VALUES ($1,$2,2,'txn-overspend',1,'HOUSE','HOUSE','AVAILABLE','USDT','v1',-500),
                  ($1,$2,2,'txn-overspend',2,'ASSET_CONTROL','ASSET_CONTROL','CONTROL',
                   'USDT','v1',-500)`,
          [WORKSPACE, POOL],
        );
        await client.query('COMMIT');
      } catch (error) {
        refusal = (error as { code?: string }).code ?? 'unknown';
        await client.query('ROLLBACK');
      }
      expect(refusal).toBe('23000');
    });
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

  // --- regression: PR 1 review, concurrent deploys both applied the same migration -----
  // Two clients read the same pending history and both executed it; the loser failed on a
  // duplicate relation rather than waiting. Reproduced with a 400ms migration: one succeeded,
  // the other failed on pg_type_typname_nsp_index in 421ms.
  describe('concurrent migration runs are serialized', () => {
    const slowSql = 'SELECT pg_sleep(0.4); CREATE TABLE overlap_target(id int primary key);';
    const slow: MigrationFile[] = [
      { version: '0001_overlap', sql: slowSql, checksum: checksumOf(slowSql) },
    ];

    async function connectInSchema(): Promise<Client> {
      const extra = new Client({ connectionString: DATABASE_URL });
      await extra.connect();
      await extra.query(`SET search_path TO ${schema}`);
      return extra;
    }

    it('applies exactly once when two clients migrate at the same time', async () => {
      const [a, b] = await Promise.all([connectInSchema(), connectInSchema()]);
      try {
        const results = await Promise.all([
          migrate(a, slow, { appliedBy: 'client-a', buildId: 'a' }),
          migrate(b, slow, { appliedBy: 'client-b', buildId: 'b' }),
        ]);

        // Both calls succeed; exactly one of them did the work.
        const applied = results.flatMap((r) => r.applied);
        const skipped = results.flatMap((r) => r.alreadyApplied);
        expect(applied).toEqual(['0001_overlap']);
        expect(skipped).toEqual(['0001_overlap']);

        const rows = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM schema_migrations',
        );
        expect(rows.rows[0]?.n).toBe(1);
      } finally {
        await Promise.all([a.end(), b.end()]);
      }
    });

    it('releases the lock so a later run is not blocked', async () => {
      const extra = await connectInSchema();
      try {
        await migrate(extra, slow, { appliedBy: 'first', buildId: 'f' });
        // Would hang if the advisory lock leaked rather than being released in `finally`.
        const second = await migrate(client, slow, { appliedBy: 'second', buildId: 's' });
        expect(second.applied).toEqual([]);
      } finally {
        await extra.end();
      }
    });

    it('releases the lock even when the run is refused', async () => {
      const extra = await connectInSchema();
      try {
        await migrate(extra, slow, { appliedBy: 'first', buildId: 'f' });
        // A divergent manifest throws; the lock must still be released.
        await expect(
          migrate(extra, [], { appliedBy: 'older', buildId: 'o' }),
        ).rejects.toBeInstanceOf(MigrationHistoryDiverged);
        const after = await migrate(client, slow, { appliedBy: 'after', buildId: 'a' });
        expect(after.alreadyApplied).toEqual(['0001_overlap']);
      } finally {
        await extra.end();
      }
    });
  });

  // --- regression: PR 1 review, an unrelated schema_migrations was trusted --------------
  // CREATE TABLE IF NOT EXISTS silently accepts a relation that merely shares the name, and
  // the migrator would then record against columns that do not mean what it thinks.
  describe('a pre-existing bookkeeping relation is validated', () => {
    it('refuses a table with the right name and the wrong columns', async () => {
      await client.query('CREATE TABLE schema_migrations (id int primary key, note text)');
      const files = await loadMigrations(MIGRATIONS_DIR);
      await expect(
        migrate(client, files, { appliedBy: 'vitest', buildId: 'b' }),
      ).rejects.toBeInstanceOf(BookkeepingTableIncompatible);
    });

    it('names what is wrong with it', async () => {
      await client.query('CREATE TABLE schema_migrations (id int primary key, note text)');
      try {
        await migrate(client, await loadMigrations(MIGRATIONS_DIR), {
          appliedBy: 'vitest',
          buildId: 'b',
        });
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as Error).message).toContain('column version is missing');
        expect((error as Error).message).toContain('primary key is (id)');
      }
    });

    it('refuses it from read-only status too, rather than reporting nonsense', async () => {
      await client.query('CREATE TABLE schema_migrations (id int primary key, note text)');
      await expect(
        migrationStatus(client, await loadMigrations(MIGRATIONS_DIR)),
      ).rejects.toBeInstanceOf(BookkeepingTableIncompatible);
    });

    it('refuses a nullable required column', async () => {
      // Same column names and types, but a null checksum defeats the immutability check.
      await client.query(`
        CREATE TABLE schema_migrations (
          version    TEXT PRIMARY KEY,
          checksum   TEXT,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          applied_by TEXT NOT NULL,
          build_id   TEXT NOT NULL
        )`);
      await expect(
        migrate(client, await loadMigrations(MIGRATIONS_DIR), { appliedBy: 'v', buildId: 'b' }),
      ).rejects.toThrow(/checksum is nullable/);
    });

    it('refuses an applied_at with no default', async () => {
      await client.query(`
        CREATE TABLE schema_migrations (
          version    TEXT PRIMARY KEY,
          checksum   TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL,
          applied_by TEXT NOT NULL,
          build_id   TEXT NOT NULL
        )`);
      await expect(
        migrate(client, await loadMigrations(MIGRATIONS_DIR), { appliedBy: 'v', buildId: 'b' }),
      ).rejects.toThrow(/applied_at has no default/);
    });

    it('refuses a composite primary key', async () => {
      await client.query(`
        CREATE TABLE schema_migrations (
          version    TEXT NOT NULL,
          checksum   TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          applied_by TEXT NOT NULL,
          build_id   TEXT NOT NULL,
          PRIMARY KEY (version, checksum)
        )`);
      await expect(
        migrate(client, await loadMigrations(MIGRATIONS_DIR), { appliedBy: 'v', buildId: 'b' }),
      ).rejects.toThrow(/primary key is \(version, checksum\)/);
    });

    it('refuses a wrong column type', async () => {
      await client.query(`
        CREATE TABLE schema_migrations (
          version    TEXT PRIMARY KEY,
          checksum   TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT '',
          applied_by TEXT NOT NULL,
          build_id   TEXT NOT NULL
        )`);
      await expect(
        migrate(client, await loadMigrations(MIGRATIONS_DIR), { appliedBy: 'v', buildId: 'b' }),
      ).rejects.toThrow(/applied_at has type text/);
    });

    // The relation unqualified SQL resolves to is the one that must be validated. Checking
    // by name across the search path mixes rows from every schema that has the name, and
    // answers the primary-key question for whichever one the name resolves to.
    it('validates the relation the search path actually resolves, not a namesake', async () => {
      const other = `${schema}_shadow`;
      await client.query(`DROP SCHEMA IF EXISTS ${other} CASCADE`);
      await client.query(`CREATE SCHEMA ${other}`);
      try {
        // A valid table in the schema that resolves first.
        await client.query(`
          CREATE TABLE schema_migrations (
            version    TEXT PRIMARY KEY,
            checksum   TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            applied_by TEXT NOT NULL,
            build_id   TEXT NOT NULL
          )`);
        // An incompatible namesake later on the path, which must not be consulted.
        await client.query(`CREATE TABLE ${other}.schema_migrations (id int primary key)`);
        await client.query(`SET search_path TO ${schema}, ${other}`);

        const files = await loadMigrations(MIGRATIONS_DIR);
        await expect(
          migrate(client, files, { appliedBy: 'vitest', buildId: 'b' }),
        ).resolves.toBeDefined();
      } finally {
        await client.query(`SET search_path TO ${schema}`);
        await client.query(`DROP SCHEMA IF EXISTS ${other} CASCADE`);
      }
    });

    it('accepts the table this migrator created', async () => {
      const files = await loadMigrations(MIGRATIONS_DIR);
      await migrate(client, files, { appliedBy: 'vitest', buildId: 'b' });
      await expect(migrate(client, files, { appliedBy: 'vitest', buildId: 'b' })).resolves.toEqual({
        applied: [],
        alreadyApplied: files.map((file) => file.version),
      });
    });
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
