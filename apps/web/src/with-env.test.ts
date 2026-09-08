import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The wrapper as the package scripts actually invoke it.
 *
 * build-env.test.ts proves the precedence rules on the pure function. This proves what that
 * function cannot: that every Next-running script goes through the wrapper, that the wrapper
 * loads nothing a production install omits, and that run as a process it applies those rules
 * and reaches the real Next binary.
 */
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = path.join(WEB_DIR, 'scripts', 'with-env.mjs');

const manifest = JSON.parse(readFileSync(path.join(WEB_DIR, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** A process environment with none of the console's own variables set. */
function cleanEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.startsWith('NEXT_PUBLIC_CAPITALDESK_') || name.startsWith('CAPITALDESK_')) continue;
    // Vitest sets NODE_ENV=test, and Next deliberately skips .env.local under it. The wrapper
    // runs with whatever NODE_ENV a developer or CI has - normally none - so the child gets
    // none, or the env-file precedence being proven here would be skipped by design.
    if (name === 'NODE_ENV') continue;
    env[name] = value;
  }
  return { ...env, ...overrides };
}

describe('package scripts run Next through the wrapper', () => {
  it('never invokes next directly', () => {
    // A script that ran `next dev` directly would bypass the defaults and precedence the
    // wrapper establishes, and next.config.ts would then fail without an API base URL - which
    // is exactly what the main developer command used to do.
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (!/\bnext\b/.test(command)) continue;
      expect(command, name).toMatch(/^node \.\/scripts\/with-env\.mjs /);
    }
    expect(manifest.scripts['dev']).toBe('node ./scripts/with-env.mjs dev --port 3100');
    expect(manifest.scripts['start']).toBe('node ./scripts/with-env.mjs start --port 3100');
    expect(manifest.scripts['build']).toBe('node ./scripts/with-env.mjs build');
    expect(manifest.scripts['typecheck']).toMatch(/^node \.\/scripts\/with-env\.mjs typegen/);
  });
});

describe('the wrapper runs on a production install', () => {
  /** Bare package specifiers a script loads at runtime, from both import and require forms. */
  function runtimeSpecifiers(file: string): string[] {
    const source = readFileSync(path.join(WEB_DIR, 'scripts', file), 'utf8');
    const found = new Set<string>();
    for (const match of source.matchAll(
      /(?:from\s+|require(?:\.resolve)?\(\s*)['"]([^'"]+)['"]/g,
    )) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      // `next/dist/bin/next` belongs to the package `next`.
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : (specifier.split('/')[0] ?? specifier);
      found.add(name);
    }
    return [...found].sort();
  }

  it('declares every package the start path loads as a production dependency', () => {
    // `pnpm start` runs after a production-only install, which omits devDependencies. A
    // wrapper that imported one would fail before Next started - which is what @next/env did
    // while it was declared under devDependencies.
    for (const file of ['with-env.mjs', 'build-env.mjs']) {
      for (const name of runtimeSpecifiers(file)) {
        expect(Object.keys(manifest.dependencies), `${file} loads ${name}`).toContain(name);
        expect(Object.keys(manifest.devDependencies), `${name} must not be dev-only`).not.toContain(
          name,
        );
      }
    }
    expect(runtimeSpecifiers('with-env.mjs')).toEqual(['@next/env', 'next']);
  });
});

describe('the wrapper as a process', () => {
  let envDir: string;

  beforeAll(() => {
    // A known env directory, so the outcome does not depend on the developer's own .env.local.
    envDir = mkdtempSync(path.join(tmpdir(), 'cd-web-env-'));
    writeFileSync(
      path.join(envDir, '.env.local'),
      'NEXT_PUBLIC_CAPITALDESK_API_BASE_URL=http://127.0.0.1:4321\n',
    );
  });
  afterAll(() => {
    rmSync(envDir, { recursive: true, force: true });
  });

  /**
   * `next --version` needs no project, so it proves the wrapper-to-Next path without a build.
   * The wrapper reads env files from its working directory, as Next does, so the known
   * directory is simply the cwd.
   */
  function run(env: Record<string, string>): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync(process.execPath, [WRAPPER, '--version'], {
      cwd: envDir,
      // Next's type augmentation makes NODE_ENV a required member of ProcessEnv, so the web
      // tsconfig needs this assertion; the tools tsconfig has no such augmentation and calls it
      // unnecessary. Both must pass, and the child deliberately has no NODE_ENV.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      env: env as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('reaches Next with local defaults filled and the env file honoured', () => {
    const ran = run(cleanEnv());
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toMatch(/Next\.js v\d+\.\d+\.\d+/);
    // The API base URL came from the env file, so it is not among the defaults applied.
    const applied = ran.stderr.match(/local defaults applied for: (.*)/)?.[1] ?? '';
    expect(applied).toContain('NEXT_PUBLIC_CAPITALDESK_ENV');
    expect(applied).not.toContain('NEXT_PUBLIC_CAPITALDESK_API_BASE_URL');
  });

  it('lets the explicit process environment beat the env file, at the process level', () => {
    const ran = run(
      cleanEnv({
        NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'http://127.0.0.1:5000',
        CAPITALDESK_BUILD_ID: 'sha-9f2b1c0',
      }),
    );
    expect(ran.status, ran.stderr).toBe(0);
    const applied = ran.stderr.match(/local defaults applied for: (.*)/)?.[1] ?? '';
    // Neither the origin (explicit) nor the build id (mapped from CAPITALDESK_BUILD_ID) is
    // defaulted.
    expect(applied).not.toContain('NEXT_PUBLIC_CAPITALDESK_API_BASE_URL');
    expect(applied).not.toContain('NEXT_PUBLIC_CAPITALDESK_BUILD_ID');
  });

  it('refuses a non-local run that is missing values, before Next starts', () => {
    const ran = run(cleanEnv({ CAPITALDESK_ENV: 'testnet' }));
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain('refusing to run `next --version` for testnet without:');
    expect(ran.stderr).toContain('NEXT_PUBLIC_CAPITALDESK_BUILD_ID');
    expect(ran.stdout).not.toMatch(/Next\.js v/);
  });

  it('runs a complete non-local configuration without applying any default', () => {
    const ran = run(
      cleanEnv({
        CAPITALDESK_ENV: 'testnet',
        NEXT_PUBLIC_CAPITALDESK_ENV: 'testnet',
        NEXT_PUBLIC_CAPITALDESK_ACCOUNT_ALIAS: 'desk-testnet',
        NEXT_PUBLIC_CAPITALDESK_BASELINE_EPOCH: '1',
        NEXT_PUBLIC_CAPITALDESK_BUILD_ID: 'abc123',
        NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'https://api.testnet.example',
      }),
    );
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stderr).not.toContain('local defaults applied');
  });
});
