import { describe, expect, it } from 'vitest';
import { LOCAL_DEFAULTS, resolveBuildEnv } from '../scripts/build-env.mjs';

/**
 * The precedence rules the build wrapper runs under, proven without a filesystem.
 */
describe('build environment resolution', () => {
  const complete = {
    NEXT_PUBLIC_CAPITALDESK_ENV: 'testnet',
    NEXT_PUBLIC_CAPITALDESK_ACCOUNT_ALIAS: 'desk-testnet',
    NEXT_PUBLIC_CAPITALDESK_BASELINE_EPOCH: '3',
    NEXT_PUBLIC_CAPITALDESK_BUILD_ID: 'abc123',
    NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'https://api.testnet.example',
  };

  it('fills every local default on a fresh checkout with nothing set', () => {
    const resolved = resolveBuildEnv({ explicit: {}, loadedFiles: {} });
    expect(resolved).toEqual({
      ok: true,
      env: { ...LOCAL_DEFAULTS },
      applied: Object.keys(LOCAL_DEFAULTS),
    });
  });

  it('lets .env.local beat the defaults', () => {
    const resolved = resolveBuildEnv({
      explicit: {},
      loadedFiles: { NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'http://127.0.0.1:4000' },
    });
    expect(resolved.ok && resolved.env['NEXT_PUBLIC_CAPITALDESK_API_BASE_URL']).toBe(
      'http://127.0.0.1:4000',
    );
    expect(resolved.ok && resolved.applied).not.toContain('NEXT_PUBLIC_CAPITALDESK_API_BASE_URL');
  });

  it('lets the explicit process environment beat .env.local', () => {
    const resolved = resolveBuildEnv({
      explicit: { NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'http://127.0.0.1:5000' },
      loadedFiles: { NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'http://127.0.0.1:4000' },
    });
    expect(resolved.ok && resolved.env['NEXT_PUBLIC_CAPITALDESK_API_BASE_URL']).toBe(
      'http://127.0.0.1:5000',
    );
  });

  it('stamps the console with the API build id from CI when no public build id is given', () => {
    // CI sets CAPITALDESK_BUILD_ID to the commit SHA for the API. Without this mapping the
    // console would be built as `dev` and report a build mismatch against the API it serves.
    const resolved = resolveBuildEnv({
      explicit: { CAPITALDESK_BUILD_ID: '9f2b1c0' },
      loadedFiles: {},
    });
    expect(resolved.ok && resolved.env['NEXT_PUBLIC_CAPITALDESK_BUILD_ID']).toBe('9f2b1c0');
    expect(resolved.ok && resolved.applied).not.toContain('NEXT_PUBLIC_CAPITALDESK_BUILD_ID');

    // An explicit public build id still wins over the mapping.
    const explicit = resolveBuildEnv({
      explicit: { CAPITALDESK_BUILD_ID: '9f2b1c0', NEXT_PUBLIC_CAPITALDESK_BUILD_ID: 'console-7' },
      loadedFiles: {},
    });
    expect(explicit.ok && explicit.env['NEXT_PUBLIC_CAPITALDESK_BUILD_ID']).toBe('console-7');
  });

  it('refuses a non-local build that is missing any value, naming each one', () => {
    const resolved = resolveBuildEnv({
      explicit: {
        CAPITALDESK_ENV: 'testnet',
        NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'https://api.testnet.example',
      },
      loadedFiles: {},
    });
    expect(resolved).toEqual({
      ok: false,
      declared: 'testnet',
      missing: [
        'NEXT_PUBLIC_CAPITALDESK_ENV',
        'NEXT_PUBLIC_CAPITALDESK_ACCOUNT_ALIAS',
        'NEXT_PUBLIC_CAPITALDESK_BASELINE_EPOCH',
        'NEXT_PUBLIC_CAPITALDESK_BUILD_ID',
      ],
    });
    // A public env declaring a real environment is refused the same way.
    expect(
      resolveBuildEnv({ explicit: {}, loadedFiles: { NEXT_PUBLIC_CAPITALDESK_ENV: 'testnet' } }).ok,
    ).toBe(false);
  });

  it('accepts a complete non-local configuration without applying any default', () => {
    const resolved = resolveBuildEnv({
      explicit: { CAPITALDESK_ENV: 'testnet', ...complete },
      loadedFiles: {},
    });
    expect(resolved).toEqual({
      ok: true,
      env: { CAPITALDESK_ENV: 'testnet', ...complete },
      applied: [],
    });
  });

  it('treats an empty string as absent, so an unset CI variable cannot satisfy a requirement', () => {
    const resolved = resolveBuildEnv({
      explicit: { CAPITALDESK_ENV: 'testnet', ...complete, NEXT_PUBLIC_CAPITALDESK_BUILD_ID: '' },
      loadedFiles: {},
    });
    expect(resolved).toMatchObject({ ok: false, missing: ['NEXT_PUBLIC_CAPITALDESK_BUILD_ID'] });
  });
});
