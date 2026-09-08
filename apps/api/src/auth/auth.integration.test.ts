import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadApiConfig } from '@capitaldesk/config';
import { loadMigrations, migrate } from '@capitaldesk/db';
import { principal } from '@capitaldesk/domain';
import { buildServer } from '../server.js';
import { IdentityRepository } from './repository.js';
import { hashHumanSecret } from './secrets.js';

/**
 * Route-level authority proof, against real PostgreSQL.
 *
 * The pure permission model is tested separately; what these prove is the part it cannot:
 * that a principal is derived only from stored credential columns, so no field a caller
 * controls selects its owner, permission level or execution account.
 */
const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

const OWNER_PASSWORD = 'owner-password-long-enough';
/** 43 base64url characters, matching the token grammar: 32 random bytes encoded. */
const AGENT_SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
/** The principal a repository-level test acts as; the HTTP tests get theirs from the server. */
const OWNER_PRINCIPAL = principal({
  kind: 'owner-session',
  role: 'owner',
  subjectId: 'u-owner',
  scope: { workspaceId: 'ws-primary', poolId: null, strategyId: null },
});
const SESSION_SECRET = 'fixture-owner-session-secret-not-a-real-value';

const WORKSPACE = 'ws-primary';
const OTHER_WORKSPACE = 'ws-other';
const POOL = 'pool-a';
const STRATEGY = 'strategy-a';
const OTHER_STRATEGY = 'strategy-b';

describeIfDatabase('identity and access', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let schema: string;
  let secretDir: string;
  let secretRef: string;
  let agentToken: string;
  let apiConfig: ReturnType<typeof loadApiConfig>;
  /** Servers a test built on an intercepting pool; closed with the primary one. */
  const extraApps: FastifyInstance[] = [];

  beforeAll(() => {
    secretDir = mkdtempSync(path.join(tmpdir(), 'cd-auth-secret-'));
    const secretFile = path.join(secretDir, 'owner-session');
    // A real file with real content. `file:///dev/null` would resolve to an empty secret and
    // would only appear to work.
    writeFileSync(secretFile, SESSION_SECRET, 'utf8');
    secretRef = pathToFileURL(secretFile).toString();
    schema = `auth_${Date.now()}`;
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool?.end();
    rmSync(secretDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    pool ??= new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);

    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}`);
      // `migrate` takes a Client; a pooled client is one for every purpose it uses.
      await migrate(client as unknown as Client, await loadMigrations(MIGRATIONS_DIR), {
        appliedBy: 'vitest',
        buildId: 'auth-test',
      });
    } finally {
      client.release();
    }

    const ownerHash = await hashHumanSecret(OWNER_PASSWORD);
    const agentHash = await hashHumanSecret(AGENT_SECRET);

    await pool.query(
      `INSERT INTO workspaces (workspace_id, display_name) VALUES ($1,'Primary'), ($2,'Other')`,
      [WORKSPACE, OTHER_WORKSPACE],
    );
    await pool.query(
      `INSERT INTO users (user_id, login_name, password_hash)
       VALUES ('u-owner','owner',$1), ('u-operator','operator',$1), ('u-viewer','viewer',$1),
              ('u-outsider','outsider',$1)`,
      [ownerHash],
    );
    await pool.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES
        ($1,'u-owner','owner'), ($1,'u-operator','operator'), ($1,'u-viewer','viewer'),
        ($2,'u-outsider','owner')`,
      [WORKSPACE, OTHER_WORKSPACE],
    );
    // A strategy belongs to a real pool, so the fixture creates the account and pool it names
    // rather than relying on an unconstrained column.
    await pool.query(
      `INSERT INTO venue_accounts (venue, environment, stable_account_id)
       VALUES ('binance-spot','local','acct-auth')`,
    );
    await pool.query(
      `INSERT INTO pools (workspace_id, pool_id, venue, environment, stable_account_id, state)
       VALUES ($1, $2, 'binance-spot', 'local', 'acct-auth', 'READY')`,
      [WORKSPACE, POOL],
    );
    await pool.query(
      `UPDATE pools SET selected_symbol='BTCUSDT', base_asset_code='BTC', base_asset_scale='v1',
                        quote_asset_code='USDT', quote_asset_scale='v1',
                        max_target_base_atoms=1000000, active_policy_version=1
        WHERE workspace_id=$1 AND pool_id=$2`,
      [WORKSPACE, POOL],
    );
    await pool.query(`INSERT INTO baseline_epochs (workspace_id,pool_id,epoch) VALUES ($1,$2,1)`, [
      WORKSPACE,
      POOL,
    ]);
    await pool.query(
      `INSERT INTO strategies (workspace_id, strategy_id, pool_id, display_name) VALUES
        ($1,$2,$3,'A'), ($1,$4,$3,'B')`,
      [WORKSPACE, STRATEGY, POOL, OTHER_STRATEGY],
    );
    await pool.query(
      `INSERT INTO agent_credentials
         (credential_id, workspace_id, pool_id, strategy_id, secret_hash, label)
       VALUES ('cred-a',$1,$2,$3,$4,'agent A')`,
      [WORKSPACE, POOL, STRATEGY, agentHash],
    );
    agentToken = `cdk_local_cred-a_${AGENT_SECRET}`;

    apiConfig = loadApiConfig({
      CAPITALDESK_ENV: 'local',
      CAPITALDESK_VENUE: 'binance-spot',
      CAPITALDESK_VENUE_BASE_URL: 'http://127.0.0.1:9443',
      CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-local',
      CAPITALDESK_BASELINE_EPOCH: '1',
      CAPITALDESK_LOG_LEVEL: 'fatal',
      CAPITALDESK_BUILD_ID: 'auth-test',
      CAPITALDESK_API_PORT: '3000',
      CAPITALDESK_OWNER_SESSION_SECRET_REF: secretRef,
      DATABASE_URL,
    });
    app = buildServer(apiConfig, { identityPool: pool });
    await app.ready();
  });

  afterEach(async () => {
    await Promise.allSettled(extraApps.splice(0).map((extra) => extra.close()));
    await app?.close();
  });

  async function login(loginName: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${WORKSPACE}/sessions`,
      payload: { loginName, password: OWNER_PASSWORD },
    });
    expect(response.statusCode, `login for ${loginName}`).toBe(201);
    const cookie = response.cookies.find((c) => c.name.endsWith('capitaldesk-session'));
    expect(cookie, 'session cookie').toBeDefined();
    return `${cookie!.name}=${cookie!.value}`;
  }

  // ------------------------------------------------------------------------------------
  describe('owner login', () => {
    it('issues an httpOnly, strict, signed session cookie', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'owner', password: OWNER_PASSWORD },
      });
      expect(response.statusCode).toBe(201);
      const cookie = response.cookies.find((c) => c.name.endsWith('capitaldesk-session'));
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite?.toLowerCase()).toBe('strict');
      expect(cookie?.['path']).toBe('/');
      // Signed values carry the signature after a dot; a bare identifier would not.
      expect(cookie?.value).toContain('.');
    });

    it('refuses a wrong password and an unknown login identically', async () => {
      const wrong = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'owner', password: 'not-the-password-x' },
      });
      const unknown = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'nobody', password: OWNER_PASSWORD },
      });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      const shape = (r: { json: <T>() => T }): unknown => {
        const body = r.json<{ code: string; message: string; retryable: boolean }>();
        // correlationId differs per request by design; everything else must be identical, or
        // the response distinguishes an unknown login from a wrong password.
        return { code: body.code, message: body.message, retryable: body.retryable };
      };
      expect(shape(wrong)).toEqual(shape(unknown));
    });

    it('refuses a body carrying extra identity fields', async () => {
      // additionalProperties: false. A body cannot smuggle a role or a user id alongside the
      // credentials and hope something downstream reads it.
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: {
          loginName: 'viewer',
          password: OWNER_PASSWORD,
          role: 'owner',
          userId: 'u-owner',
          workspaceId: OTHER_WORKSPACE,
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('cannot log a member of another workspace into this one', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'outsider', password: OWNER_PASSWORD },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rate limits repeated attempts', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 14 }, () =>
          app.inject({
            method: 'POST',
            url: `/v1/workspaces/${WORKSPACE}/sessions`,
            payload: { loginName: 'owner', password: 'wrong-password-here' },
            remoteAddress: '203.0.113.7',
          }),
        ),
      );
      expect(attempts.some((r) => r.statusCode === 429)).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('the principal comes from stored columns, not from the request', () => {
    it('reports the role recorded in the membership row', async () => {
      const cookie = await login('viewer');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie },
      });
      expect(response.json<{ role: string }>().role).toBe('viewer');
    });

    it('ignores forged identity headers entirely', async () => {
      const cookie = await login('viewer');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: {
          cookie,
          'x-role': 'owner',
          'x-user-id': 'u-owner',
          'x-workspace-id': OTHER_WORKSPACE,
          'x-capitaldesk-role': 'owner',
        },
      });
      const body = response.json<{
        role: string;
        subjectId: string;
        scope: { workspaceId: string };
      }>();
      expect(body.role).toBe('viewer');
      expect(body.subjectId).toBe('u-viewer');
      expect(body.scope.workspaceId).toBe(WORKSPACE);
    });

    it('binds an agent to the pool and strategy on its credential row', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      const body = response.json<{
        kind: string;
        role: string;
        scope: { poolId: string; strategyId: string };
      }>();
      expect(body.kind).toBe('agent-credential');
      expect(body.role).toBe('agent');
      expect(body.scope.poolId).toBe(POOL);
      expect(body.scope.strategyId).toBe(STRATEGY);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('token-type confusion', () => {
    it('refuses a request carrying both a session cookie and a bearer token', async () => {
      const cookie = await login('owner');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie, authorization: `Bearer ${agentToken}` },
      });
      // Rejected outright rather than resolved by precedence: precedence rules are where
      // confusion attacks live, and no legitimate caller sends both.
      expect(response.statusCode).toBe(401);
    });

    it('refuses an agent token presented as a session cookie', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie: `capitaldesk-session=${agentToken}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('refuses a token minted for another environment', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { authorization: agentToken.replace('cdk_local_', 'cdk_testnet_') },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('cookie signatures are verified, not assumed', () => {
    it('refuses an unsigned cookie a caller minted', async () => {
      // Registering a cookie secret does not make request.cookies trustworthy. Without an
      // explicit unsign, this value would be hashed and looked up as though we issued it.
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie: 'capitaldesk-session=forged-session-identifier' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('refuses a cookie whose signature was tampered with', async () => {
      const cookie = await login('owner');
      const tampered = `${cookie.slice(0, -3)}xyz`;
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie: tampered },
      });
      expect(response.statusCode).toBe(401);
    });

    it('refuses a cookie signed with a different secret', async () => {
      const otherDir = mkdtempSync(path.join(tmpdir(), 'cd-other-secret-'));
      try {
        const otherFile = path.join(otherDir, 'owner-session');
        writeFileSync(otherFile, 'X9wK2mP7qT4vB8nL5cD1gJ6yF3sZ0hRt', 'utf8');
        // A different *file content* must produce a different signing key. If the reference
        // string were the key, these two servers would accept each other's cookies.
        const otherApp = buildServer(
          loadApiConfig({
            CAPITALDESK_ENV: 'local',
            CAPITALDESK_VENUE: 'binance-spot',
            CAPITALDESK_VENUE_BASE_URL: 'http://127.0.0.1:9443',
            CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-local',
            CAPITALDESK_BASELINE_EPOCH: '1',
            CAPITALDESK_LOG_LEVEL: 'fatal',
            CAPITALDESK_BUILD_ID: 'auth-test',
            CAPITALDESK_API_PORT: '3000',
            CAPITALDESK_OWNER_SESSION_SECRET_REF: pathToFileURL(otherFile).toString(),
            DATABASE_URL,
          }),
          { identityPool: pool },
        );
        await otherApp.ready();
        try {
          const cookie = await login('owner');
          const response = await otherApp.inject({
            method: 'GET',
            url: `/v1/workspaces/${WORKSPACE}/principal`,
            headers: { cookie },
          });
          expect(response.statusCode).toBe(401);
        } finally {
          await otherApp.close();
        }
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }
    });
  });

  // ------------------------------------------------------------------------------------
  describe('scope is enforced on every lookup', () => {
    it('refuses a valid identifier from another workspace', async () => {
      const cookie = await login('owner');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${OTHER_WORKSPACE}/principal`,
        headers: { cookie },
      });
      // 404, not 403: confirming the resource exists would map another tenant's object graph.
      expect(response.statusCode).toBe(404);
    });

    it('refuses an agent acting on another strategy in its own pool', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${OTHER_STRATEGY}/credentials`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { label: 'escalation attempt' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses an agent issuing a credential for itself', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${STRATEGY}/credentials`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { label: 'self issue' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses an operator issuing credentials', async () => {
      const cookie = await login('operator');
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${STRATEGY}/credentials`,
        headers: { cookie },
        payload: { label: 'operator attempt' },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('session lifetime and revocation', () => {
    it('stops accepting a revoked session immediately', async () => {
      const cookie = await login('owner');
      const before = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie },
      });
      expect(before.statusCode).toBe(200);

      await pool.query(`UPDATE owner_sessions SET revoked_at = now()`);

      const after = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie },
      });
      expect(after.statusCode).toBe(401);
    });

    it('stops accepting a session past its absolute expiry', async () => {
      const cookie = await login('owner');
      // Age the whole row. The schema requires absolute_expires_at > created_at, so moving
      // only the expiry produces a row that could never have existed — which is the check
      // doing its job, not an obstacle to work around.
      await pool.query(
        `UPDATE owner_sessions
            SET created_at = now() - interval '13 hours',
                absolute_expires_at = now() - interval '1 hour',
                idle_expires_at = now() - interval '1 hour'`,
      );
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(401);
    });

    it('stops accepting a session past its idle expiry', async () => {
      const cookie = await login('owner');
      await pool.query(`UPDATE owner_sessions SET idle_expires_at = now() - interval '1 second'`);
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(401);
    });

    it('slides the idle window on activity but never past the absolute expiry', async () => {
      const cookie = await login('owner');
      const pinned = await pool.query<{ absolute_expires_at: Date }>(
        `SELECT absolute_expires_at FROM owner_sessions`,
      );
      await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie },
      });
      const after = await pool.query<{ idle_expires_at: Date; absolute_expires_at: Date }>(
        `SELECT idle_expires_at, absolute_expires_at FROM owner_sessions`,
      );
      // The absolute expiry is fixed at creation; activity never extends it.
      expect(after.rows[0]?.absolute_expires_at.getTime()).toBe(
        pinned.rows[0]?.absolute_expires_at.getTime(),
      );
      expect(after.rows[0]!.idle_expires_at.getTime()).toBeLessThanOrEqual(
        after.rows[0]!.absolute_expires_at.getTime(),
      );
    });
  });

  // ------------------------------------------------------------------------------------
  describe('agent credential lifecycle', () => {
    it('reveals the secret once and never again', async () => {
      const cookie = await login('owner');
      const csrf = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/csrf-token`,
        headers: { cookie },
      });
      const token = csrf.json<{ token: string }>().token;
      // The token is bound to a cookie the same response sets, so both travel together as a
      // browser would send them.
      const csrfCookie = csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

      const issued = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${OTHER_STRATEGY}/credentials`,
        headers: { cookie: `${cookie}; ${csrfCookie}`, 'x-csrf-token': token },
        payload: { label: 'agent B' },
      });
      expect(issued.statusCode).toBe(201);
      const body = issued.json<{ credentialId: string; token: string }>();
      expect(body.token.startsWith('cdk_local_')).toBe(true);

      // Nothing stores the secret in recoverable form, and no route returns it again.
      const stored = await pool.query<{ secret_hash: string }>(
        `SELECT secret_hash FROM agent_credentials WHERE credential_id = $1`,
        [body.credentialId],
      );
      expect(stored.rows[0]?.secret_hash.startsWith('$argon2id$')).toBe(true);
      // The last 43 characters are the secret. Splitting on '_' also splits the credential id,
      // so it could return a fragment as short as one character and assert almost nothing.
      expect(stored.rows[0]?.secret_hash).not.toContain(body.token.slice(-43));
    });

    it('refuses a revoked credential', async () => {
      await pool.query(
        `UPDATE agent_credentials SET revoked_at = now() WHERE credential_id='cred-a'`,
      );
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('refuses a credential whose strategy was archived', async () => {
      await pool.query(`UPDATE strategies SET archived_at = now() WHERE strategy_id=$1`, [
        STRATEGY,
      ]);
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('refuses a token whose secret is wrong even though the id is real', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: {
          authorization: 'Bearer cdk_local_cred-a_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('CSRF protects state-changing owner routes', () => {
    it('refuses a state-changing request with no CSRF token', async () => {
      const cookie = await login('owner');
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${OTHER_STRATEGY}/credentials`,
        headers: { cookie },
        payload: { label: 'no csrf' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('refuses a forged CSRF token', async () => {
      const cookie = await login('owner');
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${OTHER_STRATEGY}/credentials`,
        headers: { cookie, 'x-csrf-token': 'forged-token-value' },
        payload: { label: 'forged csrf' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('does not require a CSRF token for a read', async () => {
      const cookie = await login('owner');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('credential writes are one transaction, not three outcomes', () => {
    /** Owner cookie plus a matching CSRF token and its cookie, as a browser would send them. */
    async function ownerWithCsrf(): Promise<{ cookie: string; csrf: string }> {
      const cookie = await login('owner');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/csrf-token`,
        headers: { cookie },
      });
      const csrfCookie = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      return { cookie: `${cookie}; ${csrfCookie}`, csrf: response.json<{ token: string }>().token };
    }

    it('records a rotation as credential.rotate and revokes the replaced key', async () => {
      const { cookie, csrf } = await ownerWithCsrf();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${STRATEGY}/credentials/cred-a/rotations`,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { label: 'rotated agent A' },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json<{ credentialId: string }>();

      const replaced = await pool.query<{ revoked_reason: string | null }>(
        `SELECT revoked_reason FROM agent_credentials WHERE credential_id = 'cred-a'`,
      );
      // Revoked, not deleted: the row remains as evidence the key existed.
      expect(replaced.rows[0]?.revoked_reason).toBe('rotated');

      const audit = await pool.query<{ action: string; detail: Record<string, string> }>(
        `SELECT action, detail FROM audit_events WHERE action LIKE 'credential.%' ORDER BY audit_id DESC LIMIT 1`,
      );
      // ISSUE and ROTATE are different acts and are recorded as such.
      expect(audit.rows[0]?.action).toBe('credential.rotate');
      expect(audit.rows[0]?.detail).toEqual({
        credentialId: body.credentialId,
        rotatedFrom: 'cred-a',
      });
    });

    it('refuses rotation to a caller without credential.rotate', async () => {
      const cookie = await login('operator');
      const csrfResponse = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/csrf-token`,
        headers: { cookie },
      });
      const csrfCookie = csrfResponse.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${STRATEGY}/credentials/cred-a/rotations`,
        headers: {
          cookie: `${cookie}; ${csrfCookie}`,
          'x-csrf-token': csrfResponse.json<{ token: string }>().token,
        },
        payload: { label: 'not mine' },
      });
      expect(response.statusCode).toBe(404);
      const still = await pool.query(
        `SELECT 1 FROM agent_credentials WHERE credential_id='cred-a' AND revoked_at IS NULL`,
      );
      expect(still.rowCount).toBe(1);
    });

    it('cannot name a credential from another pool in the rotation predicate', async () => {
      const { cookie, csrf } = await ownerWithCsrf();
      // A real credential id, presented under a pool it does not belong to. A predicate
      // missing pool_id would revoke it anyway.
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/pool-elsewhere/strategies/${STRATEGY}/credentials/cred-a/rotations`,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { label: 'wrong pool' },
      });
      expect(response.statusCode).toBe(404);
      const untouched = await pool.query(
        `SELECT 1 FROM agent_credentials WHERE credential_id='cred-a' AND revoked_at IS NULL`,
      );
      expect(untouched.rowCount).toBe(1);
    });

    it('leaves the replaced key working when the replacement insert fails', async () => {
      // The defect this proves absent: with autocommit statements, the revoke of the old key
      // would already have committed and the owner would be left with no working credential
      // and no new one.
      //
      // The failure is targeted at the INSERT by its SQL, not by a query ordinal. Counting
      // ("fail the third query") is fragile in exactly the way that matters here: BEGIN is
      // one, so an ordinal chosen for the INSERT landed on the revoke UPDATE instead, and the
      // test proved a rollback of a mutation that had never happened.
      const executed: string[] = [];
      const repository = new IdentityRepository(
        interceptPool(pool, executed, (sql) => sql.includes('INSERT INTO agent_credentials')),
      );
      await expect(
        repository.issueAgentCredential({
          workspaceId: WORKSPACE,
          poolId: POOL,
          strategyId: STRATEGY,
          credentialId: 'cred-replacement',
          secret: AGENT_SECRET,
          label: 'doomed',
          rotatedFrom: 'cred-a',
          actor: OWNER_PRINCIPAL,
          now: new Date(),
        }),
      ).rejects.toThrow('injected failure');

      // The revoke ran to completion before the failure — and it affected the row, or the
      // repository would have returned UNKNOWN_CREDENTIAL and never reached the INSERT.
      const revokeIndex = executed.findIndex((sql) => sql.includes('SET revoked_at'));
      const insertIndex = executed.findIndex((sql) =>
        sql.includes('INSERT INTO agent_credentials'),
      );
      expect(revokeIndex, 'the revoke must have executed').toBeGreaterThan(-1);
      expect(insertIndex).toBeGreaterThan(revokeIndex);
      expect(executed[executed.length - 1]).toBe('ROLLBACK');

      // So this is PostgreSQL undoing a mutation that really happened, not a mutation that
      // never ran.
      const old = await pool.query(
        `SELECT 1 FROM agent_credentials WHERE credential_id='cred-a' AND revoked_at IS NULL`,
      );
      const replacement = await pool.query(
        `SELECT 1 FROM agent_credentials WHERE credential_id='cred-replacement'`,
      );
      const audits = await pool.query(
        `SELECT 1 FROM audit_events WHERE action LIKE 'credential.%'`,
      );
      expect(old.rowCount, 'the replaced key must still work').toBe(1);
      expect(replacement.rowCount).toBe(0);
      expect(audits.rowCount).toBe(0);
    });

    it('rolls back the revoke and the replacement when the audit write fails', async () => {
      // The companion to the previous test, at the far end of the transaction: revoke and
      // insert have both already executed, and the audit is what fails. Without one
      // transaction this leaves a rotated pair of credentials that the trail never records.
      const executed: string[] = [];
      const repository = new IdentityRepository(
        interceptPool(pool, executed, (sql) => sql.includes('INSERT INTO audit_events')),
      );
      await expect(
        repository.issueAgentCredential({
          workspaceId: WORKSPACE,
          poolId: POOL,
          strategyId: STRATEGY,
          credentialId: 'cred-late-failure',
          secret: AGENT_SECRET,
          label: 'doomed late',
          rotatedFrom: 'cred-a',
          actor: OWNER_PRINCIPAL,
          now: new Date(),
        }),
      ).rejects.toThrow('injected failure');

      const order = (fragment: string): number =>
        executed.findIndex((sql) => sql.includes(fragment));
      expect(order('SET revoked_at')).toBeGreaterThan(-1);
      expect(order('INSERT INTO agent_credentials')).toBeGreaterThan(order('SET revoked_at'));
      expect(order('INSERT INTO audit_events')).toBeGreaterThan(
        order('INSERT INTO agent_credentials'),
      );
      expect(executed[executed.length - 1]).toBe('ROLLBACK');

      const old = await pool.query(
        `SELECT 1 FROM agent_credentials WHERE credential_id='cred-a' AND revoked_at IS NULL`,
      );
      const replacement = await pool.query(
        `SELECT 1 FROM agent_credentials WHERE credential_id='cred-late-failure'`,
      );
      expect(old.rowCount, 'the replaced key must still work').toBe(1);
      expect(replacement.rowCount).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('a revocation that lands during verification wins', () => {
    it('refuses a credential revoked between the read and the final transition', async () => {
      // Argon2id verification is deliberately slow, and that window is where a revocation
      // realistically arrives. The revoke below commits on its own independent connection,
      // strictly after the credential row is read and strictly before the guarded update that
      // decides the outcome.
      const revoker = new Client({ connectionString: DATABASE_URL });
      await revoker.connect();
      try {
        await revoker.query(`SET search_path TO ${schema}`);
        let revokedAt: number | null = null;
        const repository = new IdentityRepository(
          afterFirstQuery(pool, async () => {
            await revoker.query(
              `UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'owner revoked'
                WHERE credential_id = 'cred-a'`,
            );
            revokedAt = Date.now();
          }),
        );

        const resolved = await repository.resolveAgentCredential(
          'cred-a',
          AGENT_SECRET,
          new Date(),
        );
        expect(revokedAt, 'the barrier must have fired').not.toBeNull();
        expect(resolved).toBeNull();

        // And nothing recorded the credential as having been used.
        const used = await pool.query(
          `SELECT last_used_at FROM agent_credentials WHERE credential_id='cred-a'`,
        );
        expect(used.rows[0]?.last_used_at).toBeNull();
      } finally {
        await revoker.end();
      }
    });
  });

  // ------------------------------------------------------------------------------------
  describe('a disabled account fails closed', () => {
    it('stops an existing session the moment the user is disabled', async () => {
      const cookie = await login('owner');
      const before = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie },
      });
      expect(before.statusCode).toBe(200);

      // Disabling only. No revoke-all call: correctness must not depend on a second write
      // having run and having missed nothing.
      await pool.query(`UPDATE users SET disabled_at = now() WHERE user_id = 'u-owner'`);

      const after = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { cookie },
      });
      expect(after.statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('session lifecycle belongs to human sessions only', () => {
    it('refuses an agent bearer credential at logout and writes no owner-session record', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${WORKSPACE}/sessions/current`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(response.statusCode).toBe(401);

      const forged = await pool.query(`SELECT 1 FROM audit_events WHERE action = 'session.logout'`);
      expect(forged.rowCount, 'an agent must not author an owner-session record').toBe(0);
    });

    it('refuses to mint a CSRF token for an agent bearer credential', async () => {
      // Without this, the agent holds the second half of every cookie-protected request.
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/csrf-token`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('attributes logout to the principal the server resolved', async () => {
      const cookie = await login('owner');
      const csrfResponse = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/csrf-token`,
        headers: { cookie },
      });
      const csrfCookie = csrfResponse.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${WORKSPACE}/sessions/current`,
        headers: {
          cookie: `${cookie}; ${csrfCookie}`,
          'x-csrf-token': csrfResponse.json<{ token: string }>().token,
        },
      });
      expect(response.statusCode).toBe(204);

      const audit = await pool.query<{ actor_kind: string; actor_id: string }>(
        `SELECT actor_kind, actor_id FROM audit_events WHERE action = 'session.logout'`,
      );
      expect(audit.rows[0]).toEqual({ actor_kind: 'owner-session', actor_id: 'u-owner' });
    });
  });

  // ------------------------------------------------------------------------------------
  describe('audit detail cannot carry a secret into PostgreSQL', () => {
    it('drops injected secrets before the insert, recording only how many were refused', async () => {
      const repository = new IdentityRepository(pool);
      const secrets = {
        token: `cdk_local_cred-a_${AGENT_SECRET}`,
        password: OWNER_PASSWORD,
        signedUrl: 'https://venue.test/api/v3/order?signature=abc123&apiKey=def456',
      };
      await repository.recordAudit({
        actor: { kind: 'unauthenticated', workspaceId: WORKSPACE },
        action: 'credential.issue',
        outcome: 'allowed',
        // Deliberately hostile: the type refuses these keys, so the cast is the attack.
        detail: secrets as never,
      });

      const stored = await pool.query<{ detail: Record<string, string> }>(
        `SELECT detail FROM audit_events WHERE actor_id = 'unauthenticated'`,
      );
      const serialized = JSON.stringify(stored.rows[0]?.detail);
      for (const value of Object.values(secrets)) expect(serialized).not.toContain(value);
      // A count, not the key names: object keys are caller-controlled too, so writing them
      // back would have carried a secret passed as a key straight into the column.
      expect(stored.rows[0]?.detail).toEqual({ rejectedDetailCount: '3' });
    });
  });

  // ------------------------------------------------------------------------------------
  describe('a session and the record of it commit together', () => {
    /** A server whose pool fails the statements a predicate selects. */
    function serverFailing(
      executed: string[],
      failWhen: (sql: string) => boolean,
    ): FastifyInstance {
      const extra = buildServer(apiConfig, {
        identityPool: interceptPool(pool, executed, failWhen),
      });
      extraApps.push(extra);
      return extra;
    }

    it('creates no session when its audit record cannot be written', async () => {
      const executed: string[] = [];
      const failing = serverFailing(executed, (sql) => sql.includes('INSERT INTO audit_events'));
      await failing.ready();

      const response = await failing.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'owner', password: OWNER_PASSWORD },
      });
      expect(response.statusCode).toBe(500);

      // The session INSERT ran and was rolled back. A live session that the trail does not
      // account for is the outcome this transaction exists to prevent.
      expect(executed.some((sql) => sql.includes('INSERT INTO owner_sessions'))).toBe(true);
      expect(executed[executed.length - 1]).toBe('ROLLBACK');
      const sessions = await pool.query('SELECT 1 FROM owner_sessions');
      expect(sessions.rowCount).toBe(0);
    });

    it('leaves a session live when its logout record cannot be written', async () => {
      const executed: string[] = [];
      // Armed only after login, so the login audit succeeds and the logout audit is the one
      // that fails.
      const armed = { value: false };
      const failing = serverFailing(
        executed,
        (sql) => armed.value && sql.includes('INSERT INTO audit_events'),
      );
      await failing.ready();

      const loggedIn = await failing.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'owner', password: OWNER_PASSWORD },
      });
      expect(loggedIn.statusCode).toBe(201);
      const sessionCookie = loggedIn.cookies.find((c) => c.name.endsWith('capitaldesk-session'))!;
      const csrfResponse = await failing.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/csrf-token`,
        headers: { cookie: `${sessionCookie.name}=${sessionCookie.value}` },
      });
      const csrfCookie = csrfResponse.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

      armed.value = true;
      const response = await failing.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${WORKSPACE}/sessions/current`,
        headers: {
          cookie: `${sessionCookie.name}=${sessionCookie.value}; ${csrfCookie}`,
          'x-csrf-token': csrfResponse.json<{ token: string }>().token,
        },
      });
      expect(response.statusCode).toBe(500);

      // Authority did not end unrecorded: it did not end at all.
      const live = await pool.query('SELECT 1 FROM owner_sessions WHERE revoked_at IS NULL');
      expect(live.rowCount).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('login does not reveal which workspaces exist', () => {
    it('answers identically for an unknown workspace and a wrong password', async () => {
      const unknownWorkspace = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/ws-does-not-exist/sessions`,
        payload: { loginName: 'owner', password: OWNER_PASSWORD },
      });
      const wrongPassword = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'owner', password: 'not-the-password-x' },
      });

      // The audit insert has a foreign key to workspaces. Writing the denial through the
      // ordinary path raised a 23503 and answered 500 here, and 401 there — a status code that
      // told an unauthenticated caller which workspaces exist.
      expect(unknownWorkspace.statusCode).toBe(401);
      expect(wrongPassword.statusCode).toBe(401);
      const shape = (r: { json: <T>() => T }): unknown => {
        const body = r.json<{ code: string; message: string; retryable: boolean }>();
        return { code: body.code, message: body.message, retryable: body.retryable };
      };
      expect(shape(unknownWorkspace)).toEqual(shape(wrongPassword));
    });

    it('never persists the string a caller typed into the login field', async () => {
      // The login field accepts any 3–64 character string, so an owner who pastes a password
      // into it must not create a durable copy. actor_id does not pass through the detail
      // schema, so nothing downstream would have caught it.
      const pastedPassword = 'fixture-pasted-password-not-a-real-value';
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: pastedPassword, password: OWNER_PASSWORD },
      });
      expect(response.statusCode).toBe(401);

      const audits = await pool.query<Record<string, unknown>>('SELECT * FROM audit_events');
      expect(audits.rowCount).toBe(1);
      // Every column, not only the ones we expected to be at risk.
      expect(JSON.stringify(audits.rows)).not.toContain(pastedPassword);
      expect(audits.rows[0]?.['actor_id']).toBe('unauthenticated');
    });

    it('names the user when one exists, so a real denial is still attributable', async () => {
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'owner', password: 'not-the-password-x' },
      });
      const audits = await pool.query<{ actor_id: string }>(
        `SELECT actor_id FROM audit_events WHERE outcome = 'denied'`,
      );
      expect(audits.rows[0]?.actor_id).toBe('u-owner');
    });

    it('still records the denial that has a workspace to belong to', async () => {
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/ws-does-not-exist/sessions`,
        payload: { loginName: 'owner', password: OWNER_PASSWORD },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'owner', password: 'not-the-password-x' },
      });

      // Suppressing the write for an unknown workspace must not suppress real denials.
      const denials = await pool.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM audit_events WHERE action = 'session.login' AND outcome = 'denied'`,
      );
      expect(denials.rows.map((row) => row.workspace_id)).toEqual([WORKSPACE]);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('a denied request cannot write its path into the audit trail', () => {
    it('records the principal scope and a refusal code, never the path segments', async () => {
      // An authenticated caller chooses the path. Before this, `audit_events.pool_id` and
      // `strategy_id` took those segments verbatim, so any denied request was a way to persist
      // arbitrary text next to an audit row — outside the detail schema entirely.
      const secretPool = `cdk_local_cred-x_${AGENT_SECRET}`;
      const secretStrategy = 'Tr0ub4dor.3-correct-horse';

      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${secretPool}/strategies/${secretStrategy}/credentials`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { label: 'not for an agent' },
      });
      // An agent holds no credential capability, so this is refused whatever the path says.
      expect(response.statusCode).toBe(404);

      const audits = await pool.query<Record<string, unknown>>(
        'SELECT * FROM audit_events ORDER BY audit_id',
      );
      expect(audits.rowCount).toBe(1);
      // Every column, not the ones we happened to think of.
      const serialized = JSON.stringify(audits.rows);
      expect(serialized).not.toContain(secretPool);
      expect(serialized).not.toContain(secretStrategy);
      expect(serialized).not.toContain(AGENT_SECRET);

      // What it does record: the agent's own bound scope, and a closed refusal code.
      expect(audits.rows[0]).toMatchObject({
        actor_kind: 'agent-credential',
        actor_id: 'cred-a',
        pool_id: POOL,
        strategy_id: STRATEGY,
        outcome: 'denied',
      });
      expect(audits.rows[0]?.['detail']).toEqual({
        capability: 'credential.issue',
        refusal: 'CAPABILITY_NOT_GRANTED',
      });
    });

    it('records no path segment when a revocation matches nothing', async () => {
      const cookie = await login('owner');
      const csrfResponse = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/csrf-token`,
        headers: { cookie },
      });
      const csrfCookie = csrfResponse.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const secretCredential = `cdk_local_cred-y_${AGENT_SECRET}`;

      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${STRATEGY}/credentials/${secretCredential}`,
        headers: {
          cookie: `${cookie}; ${csrfCookie}`,
          'x-csrf-token': csrfResponse.json<{ token: string }>().token,
        },
      });
      expect(response.statusCode).toBe(404);

      const audits = await pool.query<Record<string, unknown>>(
        `SELECT * FROM audit_events WHERE action = 'credential.revoke'`,
      );
      expect(audits.rowCount).toBe(1);
      expect(JSON.stringify(audits.rows)).not.toContain(secretCredential);
      // Nothing was confirmed, so no scope is recorded — not even the pool and strategy that
      // do exist, because this path did not establish that they were the ones acted on.
      expect(audits.rows[0]).toMatchObject({
        pool_id: null,
        strategy_id: null,
        outcome: 'failed',
      });
      expect(audits.rows[0]?.['detail']).toEqual({ refusal: 'NO_MATCHING_CREDENTIAL' });
    });
  });

  // ------------------------------------------------------------------------------------
  describe('cookie attributes are stated, not defaulted', () => {
    const setCookies = (headers: Record<string, unknown>): string[] => {
      const raw = headers['set-cookie'];
      return Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
    };
    const attributes = (setCookie: string): Record<string, string | true> => {
      const out: Record<string, string | true> = {};
      for (const part of setCookie.split(';').slice(1)) {
        const [name, value] = part.trim().split('=');
        out[(name ?? '').toLowerCase()] = value ?? true;
      }
      return out;
    };

    it('sets the CSRF cookie with path, HttpOnly, SameSite=Strict and a signature, locally', async () => {
      const cookie = await login('owner');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/csrf-token`,
        headers: { cookie },
      });
      const csrf = response.cookies.find((c) => c.name === 'capitaldesk-csrf');
      expect(csrf, 'csrf cookie').toBeDefined();
      const raw = setCookies(response.headers).find((h) => h.startsWith('capitaldesk-csrf='))!;
      const flags = attributes(raw);
      expect(flags['path']).toBe('/');
      expect(flags['httponly']).toBe(true);
      expect(flags['samesite']).toBe('Strict');
      expect(flags['secure']).toBeUndefined();
      // Signed: the value carries a signature after a dot.
      expect(csrf!.value).toContain('.');
    });

    it('sets both cookies __Host- prefixed and Secure outside local', async () => {
      // A testnet deployment is served over HTTPS; the strongest cookie form is required and
      // the same code path must produce it, not a separately remembered exception.
      const testnet = buildServer(
        loadApiConfig({
          CAPITALDESK_ENV: 'testnet',
          CAPITALDESK_VENUE: 'binance-spot',
          CAPITALDESK_VENUE_BASE_URL: 'https://testnet.binance.vision',
          CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-testnet',
          CAPITALDESK_BASELINE_EPOCH: '1',
          CAPITALDESK_LOG_LEVEL: 'fatal',
          CAPITALDESK_BUILD_ID: 'auth-test',
          CAPITALDESK_API_PORT: '3000',
          CAPITALDESK_OWNER_SESSION_SECRET_REF: secretRef,
          DATABASE_URL,
        }),
        { identityPool: pool },
      );
      extraApps.push(testnet);
      await testnet.ready();

      const loggedIn = await testnet.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'owner', password: OWNER_PASSWORD },
      });
      expect(loggedIn.statusCode).toBe(201);
      const session = setCookies(loggedIn.headers).find((h) =>
        h.startsWith('__Host-capitaldesk-session='),
      )!;
      expect(session, 'session cookie').toBeDefined();
      const sessionFlags = attributes(session);
      expect(sessionFlags).toMatchObject({
        path: '/',
        httponly: true,
        samesite: 'Strict',
        secure: true,
      });

      const sessionCookie = loggedIn.cookies.find((c) => c.name === '__Host-capitaldesk-session')!;
      const csrfResponse = await testnet.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/csrf-token`,
        headers: { cookie: `${sessionCookie.name}=${sessionCookie.value}` },
      });
      expect(csrfResponse.statusCode).toBe(200);
      const csrf = setCookies(csrfResponse.headers).find((h) =>
        h.startsWith('__Host-capitaldesk-csrf='),
      )!;
      expect(csrf, 'csrf cookie').toBeDefined();
      expect(attributes(csrf)).toMatchObject({
        path: '/',
        httponly: true,
        samesite: 'Strict',
        secure: true,
      });
    });
  });

  // ------------------------------------------------------------------------------------
  describe('login timing equalisation is ready before the server is', () => {
    it('has the equalisation digest precomputed once the server is ready', () => {
      // Computed at plugin registration, which `ready()` awaits. A lazily computed digest made
      // the first unknown-login request on a cold process do one hash more than a wrong
      // password - the signal the digest exists to remove.
      expect(app.timingEqualisationDigest.startsWith('$argon2id$')).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('a lost issuance response is recoverable', () => {
    async function ownerWithCsrf(): Promise<{ cookie: string; csrf: string }> {
      const cookie = await login('owner');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/csrf-token`,
        headers: { cookie },
      });
      const csrfCookie = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      return { cookie: `${cookie}; ${csrfCookie}`, csrf: response.json<{ token: string }>().token };
    }

    it('names the live credential on a duplicate issue and lets the owner rotate it', async () => {
      const { cookie, csrf } = await ownerWithCsrf();
      const issued = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${OTHER_STRATEGY}/credentials`,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { label: 'agent B' },
      });
      expect(issued.statusCode).toBe(201);
      const original = issued.json<{ credentialId: string; token: string }>();
      // The response is now lost. The owner does not know `original.credentialId`.

      // Retrying the issue is a decision, not a 500, and it names the key they cannot see.
      const retried = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${OTHER_STRATEGY}/credentials`,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { label: 'agent B again' },
      });
      expect(retried.statusCode).toBe(409);
      expect(retried.json()).toMatchObject({
        code: 'CREDENTIAL_ALREADY_ACTIVE',
        retryable: false,
        activeCredentialId: original.credentialId,
      });
      expect(JSON.stringify(retried.json())).not.toContain(original.token.slice(-43));

      // The list shows the live key and nothing secret.
      const listed = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${OTHER_STRATEGY}/credentials`,
        headers: { cookie },
      });
      expect(listed.statusCode).toBe(200);
      const body = listed.json<{
        credentials: Array<Record<string, unknown>>;
        secretRecoverable: boolean;
      }>();
      expect(body.secretRecoverable).toBe(false);
      expect(body.credentials).toHaveLength(1);
      expect(body.credentials[0]).toMatchObject({
        credentialId: original.credentialId,
        label: 'agent B',
        active: true,
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(original.token.slice(-43));
      expect(serialized).not.toContain('$argon2id$');
      expect(serialized).not.toContain('secret_hash');

      // Rotation with the recovered id mints a new secret; the old one stops working.
      const rotated = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${OTHER_STRATEGY}/credentials/${original.credentialId}/rotations`,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { label: 'agent B recovered' },
      });
      expect(rotated.statusCode).toBe(201);
      const replacement = rotated.json<{ credentialId: string; token: string }>();
      expect(replacement.credentialId).not.toBe(original.credentialId);

      const oldToken = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { authorization: `Bearer ${original.token}` },
      });
      expect(oldToken.statusCode).toBe(401);
      const newToken = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { authorization: `Bearer ${replacement.token}` },
      });
      expect(newToken.statusCode).toBe(200);
    });

    it('does not list credentials for a caller without credential.issue', async () => {
      const cookie = await login('operator');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${STRATEGY}/credentials`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(404);
      const asAgent = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${STRATEGY}/credentials`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(asAgent.statusCode).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('the authorization scheme is matched as HTTP defines it', () => {
    it('accepts every casing of the Bearer scheme and preserves the token bytes', async () => {
      for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/workspaces/${WORKSPACE}/principal`,
          headers: { authorization: `${scheme} ${agentToken}` },
        });
        expect(response.statusCode, scheme).toBe(200);
        expect(response.json<{ subjectId: string }>().subjectId).toBe('cred-a');
      }
    });

    it('still refuses another scheme, and a token whose case was altered', async () => {
      const basic = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { authorization: `Basic ${agentToken}` },
      });
      expect(basic.statusCode).toBe(401);
      // The scheme is case-insensitive; the credential is not.
      const altered = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${WORKSPACE}/principal`,
        headers: { authorization: `Bearer ${agentToken.toUpperCase()}` },
      });
      expect(altered.statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('a refused credential lifecycle action is still audited', () => {
    it('records a failed issue for a strategy that does not exist', async () => {
      const repository = new IdentityRepository(pool);
      const outcome = await repository.issueAgentCredential({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: 'strategy-ghost',
        credentialId: 'cred-ghost',
        secret: AGENT_SECRET,
        label: 'ghost',
        rotatedFrom: null,
        actor: OWNER_PRINCIPAL,
        now: new Date(),
      });
      expect(outcome).toEqual({ ok: false, reason: 'UNKNOWN_STRATEGY' });

      // The refusal is what an attempt to probe another pool's identifiers looks like, so it
      // belongs in the trail. It was silently dropped.
      const audits = await pool.query<{
        action: string;
        outcome: string;
        detail: Record<string, string>;
      }>(`SELECT action, outcome, detail FROM audit_events WHERE action LIKE 'credential.%'`);
      expect(audits.rows).toEqual([
        { action: 'credential.issue', outcome: 'failed', detail: { refusal: 'UNKNOWN_STRATEGY' } },
      ]);
    });

    it('records a failed issue when a live credential already exists', async () => {
      const repository = new IdentityRepository(pool);
      const outcome = await repository.issueAgentCredential({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: STRATEGY,
        credentialId: 'cred-second',
        secret: AGENT_SECRET,
        label: 'second',
        rotatedFrom: null,
        actor: OWNER_PRINCIPAL,
        now: new Date(),
      });
      expect(outcome).toMatchObject({ ok: false, reason: 'ACTIVE_CREDENTIAL_EXISTS' });
      const audits = await pool.query<{ outcome: string; detail: Record<string, string> }>(
        `SELECT outcome, detail FROM audit_events WHERE action = 'credential.issue'`,
      );
      expect(audits.rows).toEqual([
        {
          outcome: 'failed',
          detail: { refusal: 'ACTIVE_CREDENTIAL_EXISTS', credentialId: 'cred-a' },
        },
      ]);
    });
  });

  // ------------------------------------------------------------------------------------
  describe('versioned target proposal routes', () => {
    const target = {
      intentId: 'intent-api-1',
      symbol: 'BTCUSDT',
      targetBaseQtyAtoms: '600',
      maxBuyPrice: '62000',
      minSellPrice: '59000',
      maxQuoteDebitAtoms: '5000000',
      expiresAt: '2030-01-01T00:00:00.000Z',
      strategyRevision: '1',
      policyVersion: '1',
    } as const;

    it('accepts an agent target once and replays the stored response', async () => {
      const request = {
        method: 'POST' as const,
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${STRATEGY}/intents`,
        headers: {
          authorization: `Bearer ${agentToken}`,
          'idempotency-key': 'api-target-once',
        },
        payload: target,
      };
      const first = await app.inject(request);
      const replay = await app.inject(request);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ disposition: 'CURRENT', replayed: false });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ disposition: 'CURRENT', replayed: true });
      expect(
        (
          await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM strategy_intents WHERE intent_id='intent-api-1'`,
          )
        ).rows[0]?.count,
      ).toBe('1');
    });

    it('rejects numeric money and a cross-strategy proposal before persistence', async () => {
      const numeric = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${STRATEGY}/intents`,
        headers: { authorization: `Bearer ${agentToken}`, 'idempotency-key': 'numeric-money' },
        payload: { ...target, targetBaseQtyAtoms: 600 },
      });
      const crossScope = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${OTHER_STRATEGY}/intents`,
        headers: { authorization: `Bearer ${agentToken}`, 'idempotency-key': 'cross-target' },
        payload: target,
      });
      const unsupportedOrder = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${STRATEGY}/intents`,
        headers: {
          authorization: `Bearer ${agentToken}`,
          'idempotency-key': 'unsupported-order',
        },
        payload: { ...target, orderType: 'MARKET', timeInForce: 'GTC' },
      });
      expect(numeric.statusCode).toBe(400);
      expect(crossScope.statusCode).toBe(404);
      expect(unsupportedOrder.statusCode).toBe(400);
      expect((await pool.query('SELECT 1 FROM strategy_intents')).rowCount).toBe(0);
    });
  });

  describe('secrets never reach audit records or responses', () => {
    it('records the denial without the credential material', async () => {
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/pools/${POOL}/strategies/${OTHER_STRATEGY}/credentials`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { label: 'denied' },
      });
      const events = await pool.query<{ detail: unknown; action: string }>(
        `SELECT action, detail FROM audit_events WHERE outcome = 'denied'`,
      );
      expect(events.rowCount).toBeGreaterThan(0);
      const serialized = JSON.stringify(events.rows);
      expect(serialized).not.toContain(agentToken);
      expect(serialized).not.toContain(agentToken.split('_').pop());
    });

    it('never stores a password or session identifier in an audit record', async () => {
      const cookie = await login('owner');
      const serialized = JSON.stringify((await pool.query(`SELECT * FROM audit_events`)).rows);
      expect(serialized).not.toContain(OWNER_PASSWORD);
      expect(serialized).not.toContain(cookie.split('=')[1]);
    });

    it('does not echo the presented password in a failed login response', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/sessions`,
        payload: { loginName: 'owner', password: 'a-distinctive-wrong-password' },
      });
      expect(response.body).not.toContain('a-distinctive-wrong-password');
    });
  });
});

/**
 * A pool that runs every statement for real, records the SQL, and fails the ones a predicate
 * selects.
 *
 * Not a fake database: every other statement commits or rolls back exactly as PostgreSQL
 * decides, and the recorded log is what actually ran. What it injects is the one thing a test
 * cannot otherwise arrange — a failure at a chosen point inside a multi-statement write.
 * Selection is by SQL rather than by position, because position is not stable: `BEGIN` counts.
 */
function interceptPool(pool: Pool, executed: string[], failWhen: (sql: string) => boolean): Pool {
  return proxyPool(pool, (sql) => {
    // Record the attempt before deciding to fail it, so the log shows the statement that was
    // reached. Recording only successes would hide the very statement the test targets.
    executed.push(sql);
    if (failWhen(sql)) throw new Error('injected failure');
  });
}

/** A pool that runs a barrier once, immediately after the first statement returns. */
function afterFirstQuery(pool: Pool, barrier: () => Promise<void>): Pool {
  let fired = false;
  return proxyPool(pool, undefined, async () => {
    if (fired) return;
    fired = true;
    await barrier();
  });
}

type QueryHook = (sql: string) => void | Promise<void>;

function proxyPool(pool: Pool, before?: QueryHook, after?: QueryHook): Pool {
  const sqlOf = (first: unknown): string =>
    typeof first === 'string'
      ? first
      : typeof (first as { text?: unknown })?.text === 'string'
        ? (first as { text: string }).text
        : '';

  const hookedQuery =
    (target: { query: (...args: never[]) => unknown }) =>
    async (...args: never[]): Promise<unknown> => {
      const sql = sqlOf(args[0]);
      if (before !== undefined) await before(sql);
      const result = await (target.query as (...a: never[]) => Promise<unknown>)(...args);
      if (after !== undefined) await after(sql);
      return result;
    };

  const wrap = <T extends { query: (...args: never[]) => unknown }>(target: T): T =>
    new Proxy(target, {
      get(inner, property, receiver) {
        if (property !== 'query') return Reflect.get(inner, property, receiver);
        return hookedQuery(inner);
      },
    });

  return new Proxy(pool, {
    get(inner, property, receiver) {
      if (property === 'connect') {
        return async (): Promise<unknown> => wrap(await inner.connect());
      }
      if (property === 'query') return hookedQuery(inner);
      return Reflect.get(inner, property, receiver);
    },
  });
}
