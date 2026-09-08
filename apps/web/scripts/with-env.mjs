/**
 * Run a Next command with the browser-visible configuration it needs.
 *
 * `next.config.ts` needs the API origin whenever it is loaded — `build` bakes the same-origin
 * `/api` rewrite into the manifest, and `typegen` loads the config too. It is fail-closed on
 * purpose: a build that silently defaulted would ship a console proxying to somewhere nobody
 * chose.
 *
 * The order matters. Next's env files are loaded first, with @next/env — the same loader Next
 * itself uses, which never overrides a variable already in the process environment. Only
 * then are local defaults filled in for whatever is still missing, and only while the declared
 * environment is `local`. An earlier version filled the defaults before Next loaded
 * `.env.local`, and since Next does not override existing values, `.env.local` could never
 * win — contrary to what its own comment claimed.
 *
 * The rules themselves are in build-env.mjs, where they are unit-tested.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildEnv } from './build-env.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('usage: with-env.mjs <next command> [args...]\n');
  process.exit(2);
}

const require = createRequire(import.meta.url);
// @next/env is CommonJS; a named ESM import of it fails at load time.
const { loadEnvConfig } = require('@next/env');

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Snapshot what was set explicitly before the loader adds file values to process.env.
const explicit = { ...process.env };
const { combinedEnv } = loadEnvConfig(projectDir, args[0] === 'dev', {
  info: () => undefined,
  error: (...parts) => process.stderr.write(`${parts.join(' ')}\n`),
});

const resolved = resolveBuildEnv({ explicit, loadedFiles: combinedEnv });
if (!resolved.ok) {
  process.stderr.write(
    `refusing to run \`next ${args.join(' ')}\` for ${resolved.declared} without: ${resolved.missing.join(', ')}\n` +
      'These values are baked into the build, so a default here would ship a console ' +
      'configured for somewhere else.\n',
  );
  process.exit(2);
}
if (resolved.applied.length > 0) {
  process.stderr.write(`local defaults applied for: ${resolved.applied.join(', ')}\n`);
}

// Resolved from the dependency graph rather than PATH: `next` is only on PATH when a package
// manager put it there, so a direct `node scripts/with-env.mjs build` failed with ENOENT.
const nextBin = require.resolve('next/dist/bin/next');
const next = spawn(process.execPath, [nextBin, ...args], {
  env: resolved.env,
  stdio: 'inherit',
  shell: false,
});
next.on('exit', (code, signal) => process.exit(signal !== null ? 1 : (code ?? 1)));
next.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
