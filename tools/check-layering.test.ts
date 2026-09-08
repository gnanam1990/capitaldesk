import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CHECKER = path.join(REPO_ROOT, 'tools', 'check-layering.ts');
/**
 * The pinned workspace tsx, resolved by path. `npx tsx` launched from a temporary directory
 * resolves outside the workspace and can pick a different version, or none at all.
 */
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Build a throwaway workspace tree and run the real checker against it. */
async function fixture(files: Record<string, string>): Promise<{ code: number; output: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'cd-layering-'));
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

const API_MANIFEST = JSON.stringify({ name: '@capitaldesk/api', dependencies: {} });
const EXECUTOR_MANIFEST = JSON.stringify({ name: '@capitaldesk/executor', dependencies: {} });
const CONTRACTS_MANIFEST = JSON.stringify({ name: '@capitaldesk/contracts', dependencies: {} });

describe('dependency layering checker', () => {
  it('passes a tree with no crossing', async () => {
    const result = await fixture({
      'apps/api/package.json': API_MANIFEST,
      'apps/api/src/main.ts': 'export const ok = true;\n',
      'apps/executor/package.json': EXECUTOR_MANIFEST,
      'apps/executor/src/main.ts': 'export const ok = true;\n',
      'packages/contracts/package.json': CONTRACTS_MANIFEST,
      'packages/contracts/src/index.ts': 'export const ok = true;\n',
    });
    expect(result.output).toContain('dependency layering OK');
    expect(result.code).toBe(0);
  });

  it('catches a forbidden crossing named by package specifier', async () => {
    const result = await fixture({
      'apps/api/package.json': JSON.stringify({
        name: '@capitaldesk/api',
        dependencies: { '@capitaldesk/executor': 'workspace:*' },
      }),
      'apps/api/src/main.ts': "import '@capitaldesk/executor';\n",
      'apps/executor/package.json': EXECUTOR_MANIFEST,
      'apps/executor/src/main.ts': 'export const ok = true;\n',
      'packages/contracts/package.json': CONTRACTS_MANIFEST,
      'packages/contracts/src/index.ts': 'export const ok = true;\n',
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('is forbidden');
  });

  // --- regression: maintainer boundary probe -------------------------------------------
  // A relative re-export that climbs out of apps/api into apps/executor previously printed
  // "dependency layering OK": the checker matched specifier text and never saw a path.
  describe('path-based crossings (regression: boundary probe)', () => {
    const tree = (apiSource: string): Record<string, string> => ({
      'apps/api/package.json': API_MANIFEST,
      'apps/api/src/probe.ts': apiSource,
      'apps/executor/package.json': EXECUTOR_MANIFEST,
      'apps/executor/src/private.ts': 'export const tradeBoundary = true;\n',
      'packages/contracts/package.json': CONTRACTS_MANIFEST,
      'packages/contracts/src/index.ts': 'export const ok = true;\n',
    });

    it("catches the probe's relative re-export", async () => {
      const result = await fixture(
        tree("export { tradeBoundary } from '../../executor/src/private.js';\n"),
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain('@capitaldesk/api -> @capitaldesk/executor is forbidden');
    });

    it('catches a relative static import', async () => {
      const result = await fixture(
        tree("import { tradeBoundary } from '../../executor/src/private.js';\n"),
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain('is forbidden');
    });

    it("catches a path into another package's compiled output", async () => {
      const result = await fixture(tree("export * from '../../executor/dist/main.js';\n"));
      expect(result.code).toBe(1);
      expect(result.output).toContain('is forbidden');
    });

    it('catches a dynamic import by path', async () => {
      const result = await fixture(
        tree("export const load = () => import('../../executor/src/private.js');\n"),
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain('is forbidden');
    });

    it('reports the undeclared dependency as well as the forbidden edge', async () => {
      const result = await fixture(
        tree("export { tradeBoundary } from '../../executor/src/private.js';\n"),
      );
      expect(result.output).toContain('without declaring it as a dependency');
    });

    // --- regression: PR 1 review, one pattern swallowing another statement -------------
    // The combined specifier pattern let an `import|export ... from` branch span up to 400
    // characters, so a bare side-effect import immediately followed by another import was
    // consumed whole and its specifier never seen.
    it('catches a bare side-effect import followed by another import', async () => {
      const result = await fixture({
        'apps/api/package.json': API_MANIFEST,
        'apps/api/src/a.ts': "import '@capitaldesk/executor';\nimport { x } from './y.js';\n",
        'apps/api/src/y.ts': 'export const x = 1;\n',
        'apps/executor/package.json': EXECUTOR_MANIFEST,
        'apps/executor/src/main.ts': 'export const ok = true;\n',
        'packages/contracts/package.json': CONTRACTS_MANIFEST,
        'packages/contracts/src/index.ts': 'export const ok = true;\n',
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain('is forbidden');
    });

    it('catches a bare side-effect import by relative path', async () => {
      const result = await fixture({
        'apps/api/package.json': API_MANIFEST,
        'apps/api/src/a.ts':
          "import '../../executor/src/private.js';\nimport { x } from './y.js';\n",
        'apps/api/src/y.ts': 'export const x = 1;\n',
        'apps/executor/package.json': EXECUTOR_MANIFEST,
        'apps/executor/src/private.ts': 'export const tradeBoundary = true;\n',
        'packages/contracts/package.json': CONTRACTS_MANIFEST,
        'packages/contracts/src/index.ts': 'export const ok = true;\n',
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain('is forbidden');
    });

    it('does not let a multiline import clause swallow the next statement', async () => {
      const result = await fixture({
        'apps/api/package.json': API_MANIFEST,
        'apps/api/src/a.ts': "import {\n  x,\n} from './y.js';\nimport '@capitaldesk/executor';\n",
        'apps/api/src/y.ts': 'export const x = 1;\n',
        'apps/executor/package.json': EXECUTOR_MANIFEST,
        'apps/executor/src/main.ts': 'export const ok = true;\n',
        'packages/contracts/package.json': CONTRACTS_MANIFEST,
        'packages/contracts/src/index.ts': 'export const ok = true;\n',
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain('is forbidden');
    });

    // --- regression: PR 1 review, JavaScript sources were never scanned ------------------
    it('catches a crossing from a JavaScript source, which allowJs permits', async () => {
      const result = await fixture({
        'apps/web/package.json': JSON.stringify({ name: '@capitaldesk/web', dependencies: {} }),
        'apps/web/src/leak.js': "export * from '../../executor/src/private.js';\n",
        'apps/executor/package.json': EXECUTOR_MANIFEST,
        'apps/executor/src/private.ts': 'export const tradeBoundary = true;\n',
        'packages/contracts/package.json': CONTRACTS_MANIFEST,
        'packages/contracts/src/index.ts': 'export const ok = true;\n',
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain('is forbidden');
    });

    // --- regression: PR 1 review, regex parsing kept losing --------------------------
    // Three forms defeated the narrowed regex, and it began rejecting a commented-out
    // import. Parsing settles the class rather than moving the boundary again.
    const crossing = (source: string): Record<string, string> => ({
      'apps/api/package.json': API_MANIFEST,
      'apps/api/src/a.ts': source,
      'apps/executor/package.json': EXECUTOR_MANIFEST,
      'apps/executor/src/private.ts': 'export const tradeBoundary = true;\n',
      'packages/contracts/package.json': CONTRACTS_MANIFEST,
      'packages/contracts/src/index.ts': 'export const ok = true;\n',
    });

    const detected: ReadonlyArray<readonly [string, string]> = [
      ['comment inside a bare import', "import /* c */ '../../executor/src/private.js';\n"],
      ['comment inside export-from', "export * from /* c */ '../../executor/src/private.js';\n"],
      [
        'comment inside a dynamic import',
        "export const f = () => import(/* c */ '../../executor/src/private.js');\n",
      ],
      ['import-equals', "import e = require('@capitaldesk/executor');\nexport default e;\n"],
      ['require', "const e = require('@capitaldesk/executor');\nexport default e;\n"],
    ];

    for (const [name, source] of detected) {
      it(`detects a crossing through ${name}`, async () => {
        const result = await fixture(crossing(source));
        expect(result.code).toBe(1);
        expect(result.output).toMatch(/is forbidden|non-literal/);
      });
    }

    it('reports a non-literal dynamic specifier rather than skipping it', async () => {
      const result = await fixture(
        crossing("const p = '@capitaldesk/executor';\nexport const f = () => import(p);\n"),
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain('non-literal');
    });

    const clean: ReadonlyArray<readonly [string, string]> = [
      ['a commented-out import', "// import '@capitaldesk/executor';\nexport const ok = 1;\n"],
      [
        'a specifier inside a plain string',
        'export const s = "import \'@capitaldesk/executor\';";\n',
      ],
      [
        'a specifier inside a block comment',
        "/* import '@capitaldesk/executor'; */\nexport const ok = 1;\n",
      ],
    ];

    for (const [name, source] of clean) {
      it(`does not flag ${name}`, async () => {
        const result = await fixture(crossing(source));
        expect(result.output).toContain('dependency layering OK');
        expect(result.code).toBe(0);
      });
    }

    it('still permits a relative import inside the same package', async () => {
      const result = await fixture({
        'apps/api/package.json': API_MANIFEST,
        'apps/api/src/a.ts': "export { b } from './nested/b.js';\n",
        'apps/api/src/nested/b.ts': 'export const b = 1;\n',
        'apps/executor/package.json': EXECUTOR_MANIFEST,
        'apps/executor/src/main.ts': 'export const ok = true;\n',
        'packages/contracts/package.json': CONTRACTS_MANIFEST,
        'packages/contracts/src/index.ts': 'export const ok = true;\n',
      });
      expect(result.output).toContain('dependency layering OK');
      expect(result.code).toBe(0);
    });
  });
});
