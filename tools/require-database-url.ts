/**
 * Preflight for the integration gate.
 *
 * `vitest run --project integration` exits 0 when every database suite skips itself, so the
 * documented proof command reported a successful integration gate with 226 of 241 tests
 * skipped and no PostgreSQL anywhere. A gate that passes by not running is worse than one
 * that fails: it is a green tick attached to no evidence.
 *
 * This refuses before vitest starts. The URL is never printed — only whether it is present,
 * and which variable to set.
 */
export const DATABASE_URL_VARIABLE = 'CAPITALDESK_TEST_DATABASE_URL';

export interface PreflightResult {
  readonly ok: boolean;
  readonly message: string;
}

export function checkDatabaseUrl(env: Record<string, string | undefined>): PreflightResult {
  const value = env[DATABASE_URL_VARIABLE];
  if (value === undefined || value.trim() === '') {
    return {
      ok: false,
      message:
        `${DATABASE_URL_VARIABLE} is not set, so every real-PostgreSQL suite would skip itself ` +
        'and the run would report a passing integration gate having proved nothing.\n' +
        `Set ${DATABASE_URL_VARIABLE} to a reachable PostgreSQL 17 database and run it again.\n` +
        'To run only the process-level suites, which need no database, use ' +
        '`pnpm run test:process-only` — that is explicitly not the integration gate.',
    };
  }
  return { ok: true, message: `${DATABASE_URL_VARIABLE} is set` };
}

/* c8 ignore start -- the entry point; the decision above is what the tests exercise. */
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
) {
  const result = checkDatabaseUrl(process.env);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
  }
}
/* c8 ignore stop */
