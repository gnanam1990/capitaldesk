import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

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

/**
 * Paths permitted to mention each credential class, beyond the owning role.
 *
 * Example environment files must name the variables — that is what documents the contract —
 * and they carry placeholders only. The value-shape scan below still applies to them, so a
 * real secret pasted into one is still caught.
 */
const ENV_EXAMPLE = /(^|\/)\.?env(\..+)?\.example$/;
const TRADE_ALLOWED_PREFIXES = ['apps/executor', 'packages/config', 'tools', 'docs', 'specs'];
const READ_ALLOWED_PREFIXES = ['apps/worker', 'packages/config', 'tools', 'docs', 'specs'];

function mayName(relative: string, prefixes: readonly string[]): boolean {
  // Component-bounded: `apps/executor` must not also permit `apps/executor-evil`. Separators
  // are normalised so the same rule holds on Windows checkouts.
  const normalised = relative.split(path.sep).join('/');
  return (
    ENV_EXAMPLE.test(normalised) ||
    prefixes.some((prefix) => normalised === prefix || normalised.startsWith(`${prefix}/`))
  );
}

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

/**
 * Binary extensions worth skipping. Everything else is read, including extensionless files
 * such as `Dockerfile` and credential-bearing formats such as `.pem` and `.key`, which an
 * extension allowlist silently excluded from the scan entirely.
 */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.icns',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.br',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.node',
  '.wasm',
  '.so',
  '.dylib',
  '.dll',
]);

function isScannable(file: string): boolean {
  return !BINARY_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * The set of files that matters is the set git would publish.
 *
 * Scanning the whole working tree instead pulls in generated build artifacts — a
 * `.tsbuildinfo` carries content hashes that look exactly like a 64-character key — and that
 * noise invites a broad exemption. Broad exemptions are how the documentation carve-out came
 * to hide real matches in the first place, so the fix is a precise file set, not a filter.
 *
 * Falls back to walking the tree when git is unavailable, so the check still runs.
 */
async function filesToScan(): Promise<readonly string[]> {
  try {
    const { stdout } = await run(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
    );
    const tracked = stdout
      .split('\u0000')
      .filter((entry) => entry.length > 0)
      .map((entry) => path.join(ROOT, entry));
    if (tracked.length > 0) return tracked.filter(isScannable);
  } catch {
    // git unavailable; fall through to the filesystem walk.
  }
  return (await walk(ROOT)).filter(isScannable);
}

async function main(): Promise<void> {
  const violations: string[] = [];
  const files = await filesToScan();

  for (const file of files) {
    const relative = path.relative(ROOT, file);
    // No self-exclusion: this file is covered by the `tools` allowlist for credential *names*,
    // and its value-shape scan must still apply to it. Excluding the scanner from its own
    // scan would let a committed key hide in the one file nobody checks.
    if (SKIP_FILES.has(path.basename(file))) continue;

    const text = await readFile(file, 'utf8');

    for (const variable of TRADE_VARIABLES) {
      if (text.includes(variable) && !mayName(relative, TRADE_ALLOWED_PREFIXES)) {
        violations.push(
          `${relative}: names the trade credential variable ${variable}; only the executor ` +
            'and the config package may reference it',
        );
      }
    }
    for (const variable of READ_VARIABLES) {
      if (text.includes(variable) && !mayName(relative, READ_ALLOWED_PREFIXES)) {
        violations.push(
          `${relative}: names the read credential variable ${variable}; only the worker and ` +
            'the config package may reference it',
        );
      }
    }
    // Shape matches apply to every file, with no documentation exemption. Prose is exactly
    // where a real key gets pasted "as an example", and the previous carve-out for `docs/`
    // and `specs/` meant a credential-shaped value there was silently accepted.
    for (const { pattern, why } of SECRET_SHAPES) {
      const match = pattern.exec(text);
      if (match !== null) {
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
