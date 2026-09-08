/**
 * Run a Next command with the browser-visible configuration it needs.
 *
 * `next.config.ts` needs the API origin whenever it is loaded — `build` bakes the same-origin
 * `/api` rewrite into the manifest, and `typegen` loads the config too. It is fail-closed on
 * purpose: a build that silently defaulted would ship a console proxying to somewhere nobody
 * chose.
 *
 * That leaves the fresh checkout, where there is no `.env.local` and no deployment to read
 * from — CI, and anyone running `pnpm verify` for the first time. A local build is allowed to
 * fill in local defaults for the browser-visible values, and only a local one: as soon as
 * CAPITALDESK_ENV names a real environment, every value must be supplied and the build fails
 * if it is not. `.env.local`, when present, still wins, because Next reads it after this.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const LOCAL_DEFAULTS = {
  NEXT_PUBLIC_CAPITALDESK_ENV: 'local',
  NEXT_PUBLIC_CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-local',
  NEXT_PUBLIC_CAPITALDESK_BASELINE_EPOCH: '1',
  NEXT_PUBLIC_CAPITALDESK_BUILD_ID: 'dev',
  NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'http://127.0.0.1:3000',
};

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('usage: with-env.mjs <next command> [args...]\n');
  process.exit(2);
}

const declared = process.env.CAPITALDESK_ENV ?? process.env.NEXT_PUBLIC_CAPITALDESK_ENV ?? 'local';
const env = { ...process.env };

if (declared === 'local') {
  for (const [name, value] of Object.entries(LOCAL_DEFAULTS)) {
    env[name] ??= value;
  }
} else {
  const missing = Object.keys(LOCAL_DEFAULTS).filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) {
    process.stderr.write(
      `refusing to run \`next ${args.join(' ')}\` for ${declared} without: ${missing.join(', ')}\n` +
        'These values are baked into the build, so a default here would ship a console ' +
        'configured for somewhere else.\n',
    );
    process.exit(2);
  }
}

// Resolved from the dependency graph rather than PATH: `next` is only on PATH when a package
// manager put it there, so a direct `node scripts/with-env.mjs build` failed with ENOENT.
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const next = spawn(process.execPath, [nextBin, ...args], { env, stdio: 'inherit', shell: false });
next.on('exit', (code, signal) => process.exit(signal !== null ? 1 : (code ?? 1)));
next.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
