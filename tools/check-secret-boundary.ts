import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Static credential-boundary check (ADR-0007).
 *
 * The product's central claim is that a proposal agent cannot reach venue execution
 * authority. Part of that claim is structural and checkable without running anything: only
 * the executor may name a trade credential, only the worker may name a read credential, and
 * no committed file may contain material that looks like a live key.
 *
 * This is a static check, not proof of process isolation. The runtime boundary tests
 * (TEST-PLAN T-036/T-037) arrive with the executor in module 12; this check exists so a
 * regression in the source tree is caught long before then.
 */

const ROOT = process.cwd();

const TRADE_VARIABLES = [
  'CAPITALDESK_TRADE_CREDENTIAL_REF',
  'BINANCE_API_SECRET',
  'BINANCE_SECRET_KEY',
];
const READ_VARIABLES = ['CAPITALDESK_READ_CREDENTIAL_REF', 'BINANCE_READ_API_SECRET'];

/** Directories permitted to mention each credential class, beyond config and tooling. */
const TRADE_ALLOWED_PREFIXES = ['apps/executor', 'packages/config', 'tools', 'docs', 'specs'];
const READ_ALLOWED_PREFIXES = ['apps/worker', 'packages/config', 'tools', 'docs', 'specs'];

/** Shapes that must never appear in a committed file. */
const SECRET_SHAPES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  // A Binance key or secret is 64 mixed-case alphanumerics. Requiring an uppercase letter,
  // a lowercase letter and a digit distinguishes one from a lowercase-hex content digest,
  // which is what lockfiles and evidence manifests are full of.
  {
    pattern:
      /\b(?=[A-Za-z0-9]{64}\b)(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*[0-9])[A-Za-z0-9]{64}\b/,
    why: 'looks like a 64-character Binance API key or secret',
  },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'contains a private key block' },
];

/** Lockfiles and generated manifests carry content digests, not credentials. */
const SKIP_FILES = new Set(['pnpm-lock.yaml']);

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.next',
  '.git',
  'coverage',
  'artifacts',
]);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|json|yaml|yml|sql|md|env|example|sh)$/;

async function main(): Promise<void> {
  const violations: string[] = [];
  const files = (await walk(ROOT)).filter(
    (file) => TEXT_FILE.test(file) || path.basename(file).startsWith('.env'),
  );

  for (const file of files) {
    const relative = path.relative(ROOT, file);
    // This checker names the variables it looks for, and the spec pack discusses them.
    if (relative === 'tools/check-secret-boundary.ts') continue;
    if (SKIP_FILES.has(path.basename(file))) continue;

    const text = await readFile(file, 'utf8');

    for (const variable of TRADE_VARIABLES) {
      if (text.includes(variable) && !TRADE_ALLOWED_PREFIXES.some((p) => relative.startsWith(p))) {
        violations.push(
          `${relative}: names the trade credential variable ${variable}; only the executor ` +
            'and the config package may reference it',
        );
      }
    }
    for (const variable of READ_VARIABLES) {
      if (text.includes(variable) && !READ_ALLOWED_PREFIXES.some((p) => relative.startsWith(p))) {
        violations.push(
          `${relative}: names the read credential variable ${variable}; only the worker and ` +
            'the config package may reference it',
        );
      }
    }
    for (const { pattern, why } of SECRET_SHAPES) {
      const match = pattern.exec(text);
      if (match !== null && !relative.startsWith('specs/') && !relative.startsWith('docs/')) {
        // Report the location, never the matched material itself.
        const line = text.slice(0, match.index).split('\n').length;
        violations.push(`${relative}:${line}: ${why}`);
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write(`credential boundary violations:\n  - ${violations.join('\n  - ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`credential boundary OK (${files.length} files scanned)\n`);
}

await main();
