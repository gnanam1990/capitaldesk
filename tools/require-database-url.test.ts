import { describe, expect, it } from 'vitest';
import { DATABASE_URL_VARIABLE, checkDatabaseUrl } from './require-database-url.js';

/**
 * The integration gate must not be able to pass without a database.
 *
 * `vitest run --project integration` exits 0 when every database suite skips itself, so the
 * documented command reported a green gate with 226 of 241 tests skipped. This is the check
 * that stands in front of it.
 */
describe('integration preflight', () => {
  it('refuses when the database URL is missing or blank', () => {
    for (const env of [{}, { [DATABASE_URL_VARIABLE]: '' }, { [DATABASE_URL_VARIABLE]: '   ' }]) {
      const result = checkDatabaseUrl(env);
      expect(result.ok, JSON.stringify(env)).toBe(false);
      expect(result.message).toContain(DATABASE_URL_VARIABLE);
      // It says what to do instead, including the named non-gate command.
      expect(result.message).toContain('test:process-only');
    }
  });

  it('accepts a set URL and never echoes it', () => {
    const secretish = 'postgresql://someone:hunter2@db.example/capitaldesk';
    const result = checkDatabaseUrl({ [DATABASE_URL_VARIABLE]: secretish });
    expect(result.ok).toBe(true);
    // A preflight that printed the URL would put a password in every CI log.
    expect(result.message).not.toContain('hunter2');
    expect(result.message).not.toContain(secretish);
  });
});
