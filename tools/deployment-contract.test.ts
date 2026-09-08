import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const compose = read('deploy/compose.yaml');
const dockerfile = read('deploy/Dockerfile');
const testnet = read('deploy/config/testnet.env');
const production = read('deploy/config/production-read-only.env');
const restore = read('deploy/scripts/restore.sh');

function service(name: 'api' | 'worker' | 'executor'): string {
  const start = compose.indexOf(`  ${name}:`);
  const following = compose.slice(start + 3);
  const nextMatch = /\n {2}(?! )[a-z][a-z-]*:/.exec(following);
  const end = nextMatch === null ? compose.length : start + 3 + nextMatch.index;
  return compose.slice(start, end);
}

describe('deployment authority contract', () => {
  it('mounts the trade credential only into the separately identified executor', () => {
    expect(service('api')).not.toContain('venue_trade');
    expect(service('worker')).not.toContain('venue_trade');
    expect(service('executor')).toContain(
      'secrets: [database_url, venue_trade, authorization_evidence_store]',
    );
    expect(service('api')).toContain('user: 10001:10001');
    expect(service('worker')).toContain('user: 10002:10002');
    expect(service('executor')).toContain('user: 10003:10003');
  });

  it('loads the database connection string from a mounted secret', () => {
    expect(compose).toContain('CAPITALDESK_DATABASE_URL_REF: file:///run/secrets/database_url');
    expect(compose).not.toContain('CAPITALDESK_DATABASE_PASSWORD');
    expect(service('api')).toContain('secrets: [database_url, owner_session]');
    expect(service('worker')).toContain('secrets: [database_url, venue_read]');
    expect(dockerfile).toContain('ENTRYPOINT ["capitaldesk-start"]');
  });

  it('requires an explicit testnet-write profile for the executor', () => {
    expect(service('executor')).toContain('profiles: [testnet-write]');
    expect(testnet).toContain('CAPITALDESK_VENUE_BASE_URL=https://testnet.binance.vision');
    expect(testnet).toContain('CAPITALDESK_WRITE_CAPABILITY=disabled');
    expect(testnet).not.toContain('api.binance.com');
  });

  it('keeps production configuration read-only', () => {
    expect(production).toContain('CAPITALDESK_ENV=production-read-only');
    expect(production).toContain('CAPITALDESK_WRITE_CAPABILITY=disabled');
  });

  it('uses a non-root read-only container posture', () => {
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('cap_drop: [ALL]');
    expect(compose).toContain('no-new-privileges:true');
    expect(dockerfile).toContain('USER 10001:10001');
  });

  it('makes restore checksum, empty-target and halt posture mandatory', () => {
    expect(restore).toContain('backup checksum mismatch');
    expect(restore).toContain('restore target is not empty');
    expect(restore).toContain('HALT_AND_RECONCILE');
    expect(restore).toContain('pnpm db:restore-posture');
  });
});
