import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '@capitaldesk/db';

/**
 * The enrollment CLI as an operator actually runs it: a separate process, real stdin, real
 * exit codes, real PostgreSQL.
 *
 * In-process tests of `issueEnrollment` and `redeemEnrollment` cannot see the failures that
 * live in the entry point — a readline interface that swallows piped input, a refusal that
 * exits zero, an argument vector carrying a secret. Those are process behaviours and need a
 * process.
 *
 * These runs are piped, not interactive, so they say nothing about terminal echo: readline
 * does not echo at all when `terminal` is false. Echo suppression is proven separately in
 * input-session.test.ts, and the real-tty behaviour is a manual check recorded in
 * docs/handoffs/03.md.
 */
const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', '..', '..', '..', 'packages', 'db', 'migrations');
const CLI = path.join(HERE, '..', '..', 'dist', 'cli', 'enroll-cli.js');

const WORKSPACE = 'ws-cli';
const LOGIN = 'desk.owner';
const PASSWORD = 'correct-horse-battery-staple-7';

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** What the child was actually launched with, so a test can assert it directly. */
  readonly argv: readonly string[];
}

describeIfDatabase('enrollment CLI as a process', () => {
  const schema = `cli_${Date.now()}`;
  let admin: Client;
  let scopedUrl: string;

  /**
   * Run the built CLI, bounded.
   *
   * An unbounded child is how a CLI suite wedges a CI runner: a process waiting on stdin that
   * never closes simply never exits. On timeout this kills the child and waits for it to be
   * reaped before failing, so the failure is reported and nothing is left running.
   */
  function run(args: readonly string[], stdin = '', timeoutMs = 20_000): Promise<Ran> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { ...process.env, DATABASE_URL: scopedUrl },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.once('close', () =>
          reject(new Error(`the CLI did not exit within ${timeoutMs}ms; stderr: ${stderr}`)),
        );
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref();

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, argv: args });
      });
      child.stdin.end(stdin);
    });
  }

  beforeAll(async () => {
    // The suite runs the built entry point, not the sources, because that is what an operator
    // runs. A missing build is a failure to report, not a reason to test something else.
    expect(existsSync(CLI), `${CLI} is missing; run \`tsc -b\` first`).toBe(true);

    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    const url = new URL(DATABASE_URL as string);
    url.searchParams.set('options', `-c search_path=${schema}`);
    scopedUrl = url.toString();
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  beforeEach(async () => {
    await admin.query(`SET lock_timeout = '5s'`);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await migrate(admin, await loadMigrations(MIGRATIONS_DIR), {
      appliedBy: 'vitest',
      buildId: 'cli-test',
    });
    await admin.query(`INSERT INTO workspaces (workspace_id, display_name) VALUES ($1, 'Desk')`, [
      WORKSPACE,
    ]);
  });

  async function issue(): Promise<{ code: string; ran: Ran }> {
    const ran = await run(['issue', '--workspace', WORKSPACE, '--login', LOGIN]);
    expect(ran.code, ran.stderr).toBe(0);
    return { code: ran.stdout.trim(), ran };
  }

  it('emits the enrollment code exactly once, on stdout alone', async () => {
    const { code, ran } = await issue();
    expect(code).not.toBe('');
    // Exactly one line, and the code appears nowhere else — not in the narration on stderr.
    expect(ran.stdout.split('\n').filter((line) => line !== '')).toEqual([code]);
    expect(ran.stderr).not.toContain(code);
    expect(ran.stderr).toContain('enrollment enr-');
  });

  it('redeems from two piped lines', async () => {
    // The defect this proves absent: a second readline interface consumes the buffered
    // password along with the code, and the redeem runs with an empty password.
    const { code } = await issue();
    const ran = await run(['redeem', '--workspace', WORKSPACE], `${code}\n${PASSWORD}\n`);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toContain(`enrolled ${LOGIN} as owner`);

    const owner = await admin.query<{ role: string }>(
      `SELECT role FROM memberships WHERE workspace_id = $1`,
      [WORKSPACE],
    );
    expect(owner.rows[0]?.role).toBe('owner');
  });

  it('reads both secrets in hidden mode, so neither can reach a terminal', () => {
    // A piped run cannot observe echo — readline does not echo when `terminal` is false — so
    // this asserts the property that survives the pipe: the entry point asks for both lines
    // in the hidden mode whose suppression input-session.test.ts proves.
    const source = readFileSync(path.join(HERE, 'enroll-cli.ts'), 'utf8');
    expect(source).toContain("session.read('enrollment code: ', true)");
    expect(source).toContain("session.read('new owner password: ', true)");
    expect(source).not.toContain("', false)");
  });

  it('never echoes the code, the password or a digest into its own output or the audit trail', async () => {
    const { code } = await issue();
    const ran = await run(['redeem', '--workspace', WORKSPACE], `${code}\n${PASSWORD}\n`);
    expect(ran.code).toBe(0);

    for (const secret of [code, PASSWORD]) {
      expect(ran.stdout, 'stdout').not.toContain(secret);
      expect(ran.stderr, 'stderr').not.toContain(secret);
    }
    const audits = await admin.query('SELECT detail FROM audit_events');
    const serialized = JSON.stringify(audits.rows);
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('$argon2id$');
  });

  it('refuses a secret-shaped flag as a usage error, before any input or database work', async () => {
    // The earlier version of this test launched a child with both secrets in argv and called
    // the pass a proof that secrets stay out of argv, which it plainly was not. What the CLI
    // can actually guarantee is that such an invocation is rejected as usage — the operator is
    // told, rather than quietly served.
    const { code } = await issue();
    const ran = await run(
      ['redeem', '--workspace', WORKSPACE, '--code', code, '--password', PASSWORD],
      '',
    );
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain('secrets are read from stdin');
    // And nothing was attempted: no owner, no audit trail entry for a redemption.
    const audits = await admin.query(`SELECT 1 FROM audit_events WHERE action LIKE '%redeem%'`);
    expect(audits.rowCount).toBe(0);
  });

  it('launches a normal redeem with only the command and the workspace in argv', async () => {
    const { code } = await issue();
    const ran = await run(['redeem', '--workspace', WORKSPACE], `${code}\n${PASSWORD}\n`);
    expect(ran.code, ran.stderr).toBe(0);
    // The exact argument vector, so a future convenience flag carrying a secret would fail here.
    expect(ran.argv).toEqual(['redeem', '--workspace', WORKSPACE]);
    for (const secret of [code, PASSWORD]) {
      expect(ran.argv.join(' ')).not.toContain(secret);
    }
  });

  it('refuses unknown and duplicated flags without touching the database', async () => {
    expect((await run(['redeem', '--workspace', WORKSPACE, '--force'])).code).toBe(2);
    expect((await run(['redeem', '--workspace', WORKSPACE, '--workspace', 'ws-other'])).code).toBe(
      2,
    );
    expect((await run(['issue', '--workspace', WORKSPACE, '--login'])).code).toBe(2);
    const enrollments = await admin.query('SELECT 1 FROM owner_enrollments');
    expect(enrollments.rowCount).toBe(0);
  });

  it('exits with stable codes for usage errors, refusals and success', async () => {
    // 2 for "this invocation is wrong", 1 for "the system refused", 0 for success. A script
    // that branches on these must not have to parse prose.
    expect((await run([])).code).toBe(2);
    expect((await run(['issue'])).code).toBe(2);
    expect((await run(['issue', '--workspace'])).code).toBe(2);
    expect((await run(['issue', '--workspace', WORKSPACE])).code).toBe(2);
    expect((await run(['nonsense', '--workspace', WORKSPACE])).code).toBe(2);
    expect((await run(['redeem'])).code).toBe(2);

    expect((await run(['issue', '--workspace', 'ws-absent', '--login', LOGIN])).code).toBe(1);
    expect((await run(['redeem', '--workspace', WORKSPACE], 'nope\n' + PASSWORD + '\n')).code).toBe(
      1,
    );
    expect((await issue()).ran.code).toBe(0);
  });

  it('treats end of input as an empty answer rather than hanging', async () => {
    await issue();
    const ran = await run(['redeem', '--workspace', WORKSPACE], '');
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('refused: WEAK_PASSWORD');
  });

  it('refuses a live reissue and accepts an explicit rotation', async () => {
    const first = await issue();
    const accidental = await run(['issue', '--workspace', WORKSPACE, '--login', LOGIN]);
    expect(accidental.code).toBe(1);
    expect(accidental.stderr).toContain('LIVE_ENROLLMENT_OUTSTANDING');
    expect(accidental.stdout).toBe('');

    const rotated = await run(['issue', '--workspace', WORKSPACE, '--login', LOGIN, '--rotate']);
    expect(rotated.code).toBe(0);
    expect(rotated.stderr).toContain('(rotated)');
    expect(rotated.stdout.trim()).not.toBe(first.code);
  });
});
