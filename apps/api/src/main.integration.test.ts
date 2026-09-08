import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '@capitaldesk/db';

/**
 * The built API process, started the way the `start` script starts it.
 *
 * Server tests construct Fastify themselves and pass in whatever they need, so they prove what
 * the routes do and nothing about what production wires together. That gap was real: the entry
 * point built the server without a connection pool, so the whole identity surface was absent
 * from the shipped process while every injected test passed.
 */
const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', '..', '..', 'packages', 'db', 'migrations');
const ENTRY = path.join(HERE, '..', 'dist', 'main.js');

const WORKSPACE = 'ws-main';
const APPLICATION_NAME = 'capitaldesk-main-integration';

/** True if the promise settled inside the bound, false if the bound expired first. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describeIfDatabase('the shipped API process', () => {
  const schema = `main_${Date.now()}`;
  let admin: Client;
  let secretDir: string;
  let child: ChildProcess;
  let port: number;
  let stderr = '';

  beforeAll(async () => {
    expect(existsSync(ENTRY), `${ENTRY} is missing; run \`tsc -b\` first`).toBe(true);

    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await migrate(admin, await loadMigrations(MIGRATIONS_DIR), {
      appliedBy: 'vitest',
      buildId: 'main-test',
    });
    await admin.query(`INSERT INTO workspaces (workspace_id, display_name) VALUES ($1,'Desk')`, [
      WORKSPACE,
    ]);

    secretDir = mkdtempSync(path.join(tmpdir(), 'cd-main-secret-'));
    const secretFile = path.join(secretDir, 'owner-session');
    writeFileSync(secretFile, 'fixture-owner-session-secret-not-a-real-value', 'utf8');

    const scoped = new URL(DATABASE_URL as string);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    // Tags this process's backends so the shutdown assertion can name them exactly, rather
    // than inferring them from query text that other suites could also produce.
    scoped.searchParams.set('application_name', APPLICATION_NAME);
    port = await freePort();

    child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        CAPITALDESK_ENV: 'local',
        CAPITALDESK_VENUE: 'binance-spot',
        CAPITALDESK_VENUE_BASE_URL: 'http://127.0.0.1:9443',
        CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-local',
        CAPITALDESK_BASELINE_EPOCH: '1',
        CAPITALDESK_LOG_LEVEL: 'warn',
        CAPITALDESK_BUILD_ID: 'main-test',
        CAPITALDESK_API_PORT: String(port),
        CAPITALDESK_OWNER_SESSION_SECRET_REF: pathToFileURL(secretFile).toString(),
        DATABASE_URL: scoped.toString(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${port}/health/live`);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`the API did not start: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }, 60_000);

  afterAll(async () => {
    // Kill, then make sure the process is really gone before dropping its schema. Racing the
    // exit against a resolving timer would let cleanup proceed while the child still holds
    // connections, and DROP SCHEMA would then block on their locks — the hang this is meant
    // to prevent. If reaping does time out, the backends are terminated by name so the drop
    // has nothing to wait for, and the drop itself is bounded either way.
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGKILL');
      const reaped = await settledWithin(
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        5000,
      );
      if (!reaped) {
        await admin
          ?.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`,
            [APPLICATION_NAME],
          )
          .catch(() => undefined);
      }
    }
    await admin?.query(`SET lock_timeout = '5s'`).catch(() => undefined);
    await admin?.query(`SET statement_timeout = '15s'`).catch(() => undefined);
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
    rmSync(secretDir, { recursive: true, force: true });
  });

  it('serves the identity surface, not a 404', async () => {
    // The exact shape of the defect: with no pool, this route was never registered and the
    // not-found handler answered `UNSUPPORTED_ACTION`.
    const response = await fetch(`http://127.0.0.1:${port}/v1/workspaces/${WORKSPACE}/principal`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.message).toBe('authentication required');
  });

  it('authenticates against the PostgreSQL rows the process was pointed at', async () => {
    // A row inserted here, through a different connection, must be what the running process
    // authenticates — proving the wired pool reaches this schema and not some other default.
    const { hashHumanSecret } = await import('./auth/secrets.js');
    await admin.query(
      `INSERT INTO users (user_id, login_name, password_hash) VALUES ('usr-main','desk.owner',$1)`,
      [await hashHumanSecret('correct-horse-battery-staple-7')],
    );
    await admin.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,'usr-main','owner')`,
      [WORKSPACE],
    );

    const response = await fetch(`http://127.0.0.1:${port}/v1/workspaces/${WORKSPACE}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        loginName: 'desk.owner',
        password: 'correct-horse-battery-staple-7',
      }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('capitaldesk-session');

    const audited = await admin.query(
      `SELECT 1 FROM audit_events WHERE action = 'session.login' AND outcome = 'allowed'`,
    );
    expect(audited.rowCount).toBe(1);
  });

  it('exits cleanly on SIGTERM and leaves no database session behind', async () => {
    const backendCount = async (): Promise<number> => {
      const result = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name = $1`,
        [APPLICATION_NAME],
      );
      return Number(result.rows[0]?.count ?? '-1');
    };

    // The claim is only meaningful if there was something to leak.
    expect(await backendCount(), 'the process must hold pooled connections').toBeGreaterThan(0);

    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });
    child.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`the process did not exit; stderr: ${stderr}`)), 15_000),
      ),
    ]);
    expect(code).toBe(0);

    // The pool was closed, not merely abandoned with the process.
    const deadline = Date.now() + 5000;
    let remaining = await backendCount();
    while (remaining !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      remaining = await backendCount();
    }
    expect(remaining).toBe(0);
  }, 30_000);
});
