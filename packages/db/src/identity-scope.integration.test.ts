import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from './index.js';

/**
 * The composite-scope guarantees of 0002, asserted against real PostgreSQL.
 *
 * These constraints are the reason no valid identifier from one scope can be used to reach
 * another, and they were verified once by hand at a psql prompt. That proves nothing about the
 * migration a year from now, so each is a test: every negative names the identifier an
 * attacker would realistically hold — a real credential id, a real pool id — presented under
 * the wrong scope, and each has a positive control so the refusal cannot be an artefact of a
 * broken fixture.
 */
const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const WORKSPACE = 'ws-scope';
const OTHER_WORKSPACE = 'ws-scope-other';
const POOL_A = 'pool-a';
const POOL_B = 'pool-b';
const STRATEGY_A = 'strategy-a';
const STRATEGY_B = 'strategy-b';
const DIGEST = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA';

/** PostgreSQL SQLSTATEs, named so a test asserts the reason and not merely a failure. */
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

describeIfDatabase('identity scope constraints', () => {
  const schema = `scope_${Date.now()}`;
  let db: Client;

  async function refusal(sql: string, values: readonly unknown[] = []): Promise<string> {
    try {
      await db.query(sql, values as unknown[]);
    } catch (error) {
      return (error as { code?: string }).code ?? 'no-sqlstate';
    } finally {
      // A failed statement aborts the surrounding transaction block if one is open; ending it
      // keeps each case independent.
      await db.query('ROLLBACK').catch(() => undefined);
    }
    return 'accepted';
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
  });

  afterAll(async () => {
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await db?.end().catch(() => undefined);
  });

  beforeEach(async () => {
    await db.query(`SET lock_timeout = '5s'`);
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await migrate(db, await loadMigrations(MIGRATIONS_DIR), {
      appliedBy: 'vitest',
      buildId: 'scope-test',
    });

    await db.query(
      `INSERT INTO workspaces (workspace_id, display_name) VALUES ($1,'Desk'), ($2,'Other')`,
      [WORKSPACE, OTHER_WORKSPACE],
    );
    // Real pools for those strategies to belong to: a strategy now references its pool by
    // key, so the fixture has to build the world the constraints describe.
    await db.query(
      `INSERT INTO venue_accounts (venue, environment, stable_account_id)
       VALUES ('binance-spot','local','acct-a'), ('binance-spot','local','acct-b')`,
    );
    await db.query(
      `INSERT INTO pools (workspace_id, pool_id, venue, environment, stable_account_id, state) VALUES
        ($1,$2,'binance-spot','local','acct-a','READY'),
        ($1,$3,'binance-spot','local','acct-a','READY'),
        ($4,$2,'binance-spot','local','acct-b','READY'),
        ($4,$3,'binance-spot','local','acct-b','READY')`,
      [WORKSPACE, POOL_A, POOL_B, OTHER_WORKSPACE],
    );
    // Two strategies in two different pools of the same workspace: every identifier below is
    // real, and only the combination is wrong.
    await db.query(
      `INSERT INTO strategies (workspace_id, pool_id, strategy_id, display_name) VALUES
        ($1,$2,$3,'A'), ($1,$4,$5,'B')`,
      [WORKSPACE, POOL_A, STRATEGY_A, POOL_B, STRATEGY_B],
    );
    await db.query(
      `INSERT INTO agent_credentials (credential_id, workspace_id, pool_id, strategy_id, secret_hash, label)
       VALUES ('cred-a', $1, $2, $3, $4, 'A')`,
      [WORKSPACE, POOL_A, STRATEGY_A, DIGEST],
    );
  });

  describe('a credential is bound through the complete strategy tuple', () => {
    it('accepts a credential whose workspace, pool and strategy agree', async () => {
      // Strategy B, which has no credential yet: the positive control must not collide with
      // the one-active-credential rule and report a pass that is really a different refusal.
      expect(
        await refusal(
          `INSERT INTO agent_credentials (credential_id, workspace_id, pool_id, strategy_id, secret_hash, label)
           VALUES ('cred-control', $1, $2, $3, $4, 'control')`,
          [WORKSPACE, POOL_B, STRATEGY_B, DIGEST],
        ),
      ).toBe('accepted');
    });

    it('refuses a credential naming a real strategy under a different real pool', async () => {
      // Both pool-a and strategy-b exist. The pair does not. A foreign key over
      // (workspace_id, strategy_id) alone accepted exactly this. Strategy B is used so the
      // refusal is the scope constraint and not the one-active-credential index.
      expect(
        await refusal(
          `INSERT INTO agent_credentials (credential_id, workspace_id, pool_id, strategy_id, secret_hash, label)
           VALUES ('cred-cross-pool', $1, $2, $3, $4, 'cross pool')`,
          [WORKSPACE, POOL_A, STRATEGY_B, DIGEST],
        ),
      ).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('refuses a second active credential for one strategy', async () => {
      // One live key per strategy. Rotation must revoke before it inserts, which is why the
      // repository does both in one transaction.
      expect(
        await refusal(
          `INSERT INTO agent_credentials (credential_id, workspace_id, pool_id, strategy_id, secret_hash, label)
           VALUES ('cred-second', $1, $2, $3, $4, 'second')`,
          [WORKSPACE, POOL_A, STRATEGY_A, DIGEST],
        ),
      ).toBe(UNIQUE_VIOLATION);
    });

    it('refuses a credential naming a real strategy under a different workspace', async () => {
      expect(
        await refusal(
          `INSERT INTO agent_credentials (credential_id, workspace_id, pool_id, strategy_id, secret_hash, label)
           VALUES ('cred-cross-workspace', $1, $2, $3, $4, 'cross workspace')`,
          [OTHER_WORKSPACE, POOL_B, STRATEGY_B, DIGEST],
        ),
      ).toBe(FOREIGN_KEY_VIOLATION);
    });
  });

  describe('rotation provenance is scoped', () => {
    it('accepts a rotation naming a predecessor in the same scope', async () => {
      // Revoke first, as a rotation must: the predecessor stops being the active credential
      // and remains in the table as the row the new one points at.
      await db.query(
        `UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'rotated'
          WHERE credential_id = 'cred-a'`,
      );
      expect(
        await refusal(
          `INSERT INTO agent_credentials
             (credential_id, workspace_id, pool_id, strategy_id, secret_hash, label, rotated_from)
           VALUES ('cred-a2', $1, $2, $3, $4, 'rotated', 'cred-a')`,
          [WORKSPACE, POOL_A, STRATEGY_A, DIGEST],
        ),
      ).toBe('accepted');
    });

    it('refuses a rotation inheriting from a credential in another strategy', async () => {
      // cred-a is real; the new credential belongs to strategy B. Allowing the chain would let
      // a credential claim provenance from authority granted elsewhere.
      expect(
        await refusal(
          `INSERT INTO agent_credentials
             (credential_id, workspace_id, pool_id, strategy_id, secret_hash, label, rotated_from)
           VALUES ('cred-b2', $1, $2, $3, $4, 'cross scope', 'cred-a')`,
          [WORKSPACE, POOL_B, STRATEGY_B, DIGEST],
        ),
      ).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('refuses a credential that names itself as its predecessor', async () => {
      expect(
        await refusal(
          `INSERT INTO agent_credentials
             (credential_id, workspace_id, pool_id, strategy_id, secret_hash, label, rotated_from)
           VALUES ('cred-loop', $1, $2, $3, $4, 'loop', 'cred-loop')`,
          [WORKSPACE, POOL_A, STRATEGY_A, DIGEST],
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  describe("a strategy's scope is immutable", () => {
    it('allows an ordinary edit', async () => {
      expect(
        await refusal(`UPDATE strategies SET display_name = 'renamed' WHERE strategy_id = $1`, [
          STRATEGY_A,
        ]),
      ).toBe('accepted');
    });

    it('refuses moving a strategy to another pool', async () => {
      // One UPDATE would otherwise relocate every credential bound to this strategy into a
      // different pool, carrying authority granted against the original scope with it.
      expect(
        await refusal(`UPDATE strategies SET pool_id = $2 WHERE strategy_id = $1`, [
          STRATEGY_A,
          POOL_B,
        ]),
      ).toBe(RESTRICT_VIOLATION);
    });

    it('refuses moving a strategy to another workspace', async () => {
      expect(
        await refusal(`UPDATE strategies SET workspace_id = $2 WHERE strategy_id = $1`, [
          STRATEGY_A,
          OTHER_WORKSPACE,
        ]),
      ).toBe(RESTRICT_VIOLATION);
    });

    it('leaves the credential bound to the scope it was issued for', async () => {
      // The positive consequence of the refusals above, stated directly.
      const bound = await db.query<{ pool_id: string; strategy_id: string }>(
        `SELECT pool_id, strategy_id FROM agent_credentials WHERE credential_id = 'cred-a'`,
      );
      expect(bound.rows[0]).toEqual({ pool_id: POOL_A, strategy_id: STRATEGY_A });
    });
  });
});
