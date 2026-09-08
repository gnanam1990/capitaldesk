import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CHECKER = path.join(REPO_ROOT, 'tools', 'check-secret-boundary.ts');
/** The pinned workspace tsx, resolved by path rather than via npx from a temporary root. */
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/**
 * Secret-shaped fixtures, assembled at runtime.
 *
 * A committed 64-character mixed-case token is indistinguishable from a leaked key — to this
 * scanner and to any other — so the fixtures that prove detection must not themselves be
 * literals. That is the same rule the scanner enforces on the rest of the tree.
 */
const KEY_SHAPED = ['aB3dEfGh1jKlMnOpQrStUvWxYz234567', 'HgFeDcBa9876543210ZyXwVuTsRqPoNm'].join(
  '',
);
// The body is split for the same reason as KEY_SHAPED: a 64-character mixed-case run is
// indistinguishable from a key, and the scanner correctly flags one when it appears whole.
const PRIVATE_KEY_BLOCK = [
  `-----BEGIN${' '}RSA PRIVATE KEY-----`,
  ['MIIBOgIBAAJBAKj34GkxFhD90', 'vcNLYLInFEX6Ppy1tPf9Cnzj4', 'p4WGeKLs1Pt8Qu'].join(''),
  `-----END${' '}RSA PRIVATE KEY-----`,
].join('\n');
/** A lowercase sha256 digest: the shape the scanner must NOT flag. */
const CONTENT_DIGEST = 'e650ecb6b6aca673b03df44dfe65dbe29d21d32ee2bd6fe0347113b070334ad0';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>): Promise<{ code: number; output: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'cd-secrets-'));
  created.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents, 'utf8');
  }
  try {
    const { stdout } = await run(TSX, [CHECKER], { cwd: root });
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/** A minimal tree the scanner is happy with, so each case adds exactly one variable. */
const BASE: Record<string, string> = {
  'packages/config/src/env.ts': 'export const TRADE = "CAPITALDESK_TRADE_CREDENTIAL_REF";\n',
  'apps/executor/src/main.ts': 'export const ok = true;\n',
  'apps/worker/src/main.ts': 'export const ok = true;\n',
};

describe('credential boundary checker', () => {
  it('passes a clean tree', async () => {
    const result = await fixture(BASE);
    expect(result.output).toContain('credential boundary OK');
    expect(result.code).toBe(0);
  });

  // --- regression: PR 1 review, six ways past the scanner ------------------------------
  describe('documentation is not exempt from shape matching', () => {
    it('detects a key-shaped value under docs/', async () => {
      const result = await fixture({ ...BASE, 'docs/notes.md': `key = ${KEY_SHAPED}\n` });
      expect(result.code).toBe(1);
      expect(result.output).toContain('docs/notes.md');
    });

    it('detects a key-shaped value under specs/', async () => {
      const result = await fixture({ ...BASE, 'specs/pack.md': `key = ${KEY_SHAPED}\n` });
      expect(result.code).toBe(1);
      expect(result.output).toContain('specs/pack.md');
    });
  });

  describe('file coverage is not limited to an extension allowlist', () => {
    it('detects a private key block in a .pem file', async () => {
      const result = await fixture({ ...BASE, 'apps/api/server.pem': PRIVATE_KEY_BLOCK });
      expect(result.code).toBe(1);
      expect(result.output).toContain('server.pem');
    });

    it('detects a key in an extensionless Dockerfile', async () => {
      const result = await fixture({
        ...BASE,
        'apps/api/Dockerfile': `ENV BINANCE_API_SECRET=${KEY_SHAPED}\n`,
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain('Dockerfile');
    });

    it('detects a private key in a .key file', async () => {
      const result = await fixture({ ...BASE, 'deploy/tls.key': PRIVATE_KEY_BLOCK });
      expect(result.code).toBe(1);
      expect(result.output).toContain('tls.key');
    });
  });

  it('does not let a sibling directory inherit the executor allowlist', async () => {
    const result = await fixture({
      ...BASE,
      'apps/executor-evil/src/x.ts':
        'export default process.env.CAPITALDESK_TRADE_CREDENTIAL_REF;\n',
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('executor-evil');
  });

  it('scans its own source rather than excluding it', async () => {
    // The scanner used to skip its own file, making it the one place a key could hide.
    const result = await fixture({
      ...BASE,
      'tools/check-secret-boundary.ts': `// ${KEY_SHAPED}\n`,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('check-secret-boundary.ts');
  });

  describe('credential variables are bound to their owning role', () => {
    it('rejects a trade credential named outside the executor and config', async () => {
      const result = await fixture({
        ...BASE,
        'apps/web/src/leak.ts': 'export default process.env.CAPITALDESK_TRADE_CREDENTIAL_REF;\n',
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain('names the trade credential variable');
      expect(result.output).toContain('apps/web/src/leak.ts');
    });

    it('rejects a read credential named outside the worker and config', async () => {
      const result = await fixture({
        ...BASE,
        'apps/api/src/leak.ts': 'export default process.env.CAPITALDESK_READ_CREDENTIAL_REF;\n',
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain('CAPITALDESK_READ_CREDENTIAL_REF');
    });

    it('permits the executor to name its own trade credential', async () => {
      const result = await fixture({
        ...BASE,
        'apps/executor/src/main.ts':
          'export default process.env.CAPITALDESK_TRADE_CREDENTIAL_REF;\n',
      });
      expect(result.output).toContain('credential boundary OK');
      expect(result.code).toBe(0);
    });
  });

  describe('positive controls: legitimate content must not be flagged', () => {
    it('permits an env example naming the credential variables', async () => {
      const result = await fixture({
        ...BASE,
        '.env.example': [
          '# placeholders only',
          '# CAPITALDESK_TRADE_CREDENTIAL_REF=file:///run/secrets/venue-trade',
          '# CAPITALDESK_READ_CREDENTIAL_REF=file:///run/secrets/venue-read',
        ].join('\n'),
      });
      expect(result.output).toContain('credential boundary OK');
      expect(result.code).toBe(0);
    });

    it('still flags a real key value pasted into an env example', async () => {
      // Naming the variables is allowed; carrying a value is not.
      const result = await fixture({
        ...BASE,
        '.env.example': `BINANCE_API_SECRET=${KEY_SHAPED}\n`,
      });
      expect(result.code).toBe(1);
    });

    it('does not flag a lowercase sha256 content digest', async () => {
      const result = await fixture({
        ...BASE,
        'docs/manifest.md': `TDD.md: ${CONTENT_DIGEST}\n`,
      });
      expect(result.output).toContain('credential boundary OK');
      expect(result.code).toBe(0);
    });

    it('does not flag an owner name or ordinary prose of the same length', async () => {
      const sixtyFourLetters = 'a'.repeat(64);
      const result = await fixture({
        ...BASE,
        'docs/people.md': `owner: gnanam1990\nlorem: ${sixtyFourLetters}\n`,
      });
      expect(result.output).toContain('credential boundary OK');
      expect(result.code).toBe(0);
    });

    it('does not flag a base64-looking string shorter than a key', async () => {
      const result = await fixture({ ...BASE, 'docs/short.md': `token = ${'aB3d'.repeat(8)}\n` });
      expect(result.output).toContain('credential boundary OK');
      expect(result.code).toBe(0);
    });
  });
});
