import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

/**
 * Mechanical dependency-layer check (TDD section 2).
 *
 * The layering rule is an architectural claim the product makes about itself, so it is
 * enforced by a command rather than by convention.
 *
 * Every import is resolved to the workspace package that *owns the file on disk*, not to
 * the text of its specifier. A package specifier and a relative path that climbs out of
 * one package into another are the same crossing, and an earlier version of this checker
 * saw only the first: `export { x } from '../../executor/src/private.js'` inside apps/api
 * passed cleanly. Ownership resolution closes that, and covers paths into another
 * package's compiled `dist/` output as well.
 */

const ROOT = process.cwd();

/** Layer 0 depends on nothing internal; each layer may depend only on strictly lower ones. */
const LAYERS: ReadonlyArray<readonly string[]> = [
  ['@capitaldesk/contracts'],
  [
    '@capitaldesk/config',
    '@capitaldesk/observability',
    '@capitaldesk/domain',
    '@capitaldesk/binance',
    '@capitaldesk/ledger',
    '@capitaldesk/planner',
    '@capitaldesk/reconciler',
  ],
  ['@capitaldesk/db'],
  [
    '@capitaldesk/api',
    '@capitaldesk/worker',
    '@capitaldesk/executor',
    '@capitaldesk/web',
    '@capitaldesk/fault-lab',
  ],
];

const LAYER_OF = new Map<string, number>();
LAYERS.forEach((names, index) => names.forEach((name) => LAYER_OF.set(name, index)));

/**
 * Boundaries that are not merely layering but trust boundaries. The web console must never
 * reach the executor, the database or a credential-bearing module, whatever the layer
 * numbers would otherwise allow (TDD section 2).
 */
const FORBIDDEN: ReadonlyArray<{ from: string; to: string; why: string }> = [
  {
    from: '@capitaldesk/web',
    to: '@capitaldesk/db',
    why: 'the console must reach data through the API, never through the database directly',
  },
  {
    from: '@capitaldesk/web',
    to: '@capitaldesk/executor',
    why: 'the console must never import the credential-holding execution boundary',
  },
  {
    from: '@capitaldesk/api',
    to: '@capitaldesk/executor',
    why: 'the API must not import the component holding the venue trade credential',
  },
  {
    from: '@capitaldesk/worker',
    to: '@capitaldesk/executor',
    why: 'the worker holds a read credential and must not import the trade boundary',
  },
];

interface Manifest {
  readonly name: string;
  /** Absolute directory, with a trailing separator so prefix matching cannot half-match. */
  readonly dir: string;
  readonly dependencies: readonly string[];
}

async function loadManifests(): Promise<readonly Manifest[]> {
  const manifests: Manifest[] = [];
  for (const group of ['packages', 'apps']) {
    for (const entry of await readdir(path.join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(ROOT, group, entry.name);
      const raw = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      manifests.push({
        name: raw.name,
        dir: dir + path.sep,
        dependencies: [
          ...Object.keys(raw.dependencies ?? {}),
          ...Object.keys(raw.devDependencies ?? {}),
        ].filter((name) => name.startsWith('@capitaldesk/')),
      });
    }
  }
  return manifests;
}

/** Which workspace package owns an absolute path, if any. Longest prefix wins. */
function ownerOf(manifests: readonly Manifest[], absolutePath: string): Manifest | null {
  let best: Manifest | null = null;
  for (const manifest of manifests) {
    if (!absolutePath.startsWith(manifest.dir)) continue;
    if (best === null || manifest.dir.length > best.dir.length) best = manifest;
  }
  return best;
}

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      // An absent src/ directory is legitimate. Anything else — a permission error, an I/O
      // failure — must not be swallowed, because silently skipping a subtree lets the checker
      // report success while enforcing nothing.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next')
        continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      // JavaScript is included: the web package enables allowJs, so a .js module can cross a
      // trust boundary exactly like a .ts one and was previously unchecked.
      else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

/**
 * Every module specifier in a file, read from the TypeScript AST.
 *
 * This was regex-based and kept losing. A combined pattern let one statement swallow the
 * next; narrowing it then missed `import /* c *\/ 'x'`, `export * from /* c *\/ 'x'` and
 * `import(/* c *\/ 'x')`, and started rejecting a *commented-out* import — a false positive
 * on top of the false negatives. Each fix moved the boundary rather than closing the class.
 *
 * A parser settles it. Comments and strings are handled by definition, and the forms below
 * are the complete set of ways a module specifier can appear:
 *
 *  - `import ... from 'x'` and bare `import 'x'`   (ImportDeclaration)
 *  - `export ... from 'x'` and `export * from 'x'` (ExportDeclaration)
 *  - `import('x')`                                 (dynamic import call)
 *  - `require('x')`                                (CommonJS)
 *  - `import x = require('x')`                     (TypeScript import-equals)
 *
 * A non-literal specifier — `import(someVariable)` — cannot be resolved statically. It is
 * reported rather than ignored, because silently skipping it is how a boundary check starts
 * lying about its coverage.
 */
function scriptKindOf(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

export interface FileSpecifiers {
  readonly specifiers: readonly string[];
  /** Specifiers the parser found but could not resolve to a literal string. */
  readonly dynamic: readonly string[];
}

function specifiersIn(file: string, text: string): FileSpecifiers {
  const source = ts.createSourceFile(
    file,
    text,
    { languageVersion: ts.ScriptTarget.Latest },
    /* setParentNodes */ false,
    scriptKindOf(file),
  );

  const specifiers = new Set<string>();
  const dynamic: string[] = [];

  const record = (node: ts.Node | undefined, description: string): void => {
    if (node === undefined) return;
    if (ts.isStringLiteralLike(node)) specifiers.add(node.text);
    else
      dynamic.push(
        `${description} at line ${source.getLineAndCharacterOfPosition(node.pos).line + 1}`,
      );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // Covers `import x from 'a'`, `import 'a'` and `import type ... from 'a'`.
      record(node.moduleSpecifier, 'import');
    } else if (ts.isExportDeclaration(node)) {
      // `export * from 'a'`, `export { x } from 'a'`. Absent for a local export.
      if (node.moduleSpecifier !== undefined) record(node.moduleSpecifier, 'export-from');
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression, 'import-equals');
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        record(node.arguments[0], isDynamicImport ? 'dynamic import' : 'require');
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return { specifiers: [...specifiers], dynamic };
}

async function main(): Promise<void> {
  const manifests = await loadManifests();
  const violations: string[] = [];
  let crossings = 0;

  for (const manifest of manifests) {
    const fromLayer = LAYER_OF.get(manifest.name);
    if (fromLayer === undefined) {
      violations.push(`${manifest.name}: not assigned to a layer in tools/check-layering.ts`);
      continue;
    }

    const check = (target: string, origin: string, declared: ReadonlySet<string> | null): void => {
      if (target === manifest.name) return;
      crossings += 1;
      const toLayer = LAYER_OF.get(target);
      if (toLayer === undefined) {
        violations.push(`${origin}: depends on unlayered package ${target}`);
        return;
      }
      if (toLayer >= fromLayer) {
        violations.push(
          `${origin}: ${manifest.name} (layer ${fromLayer}) may not depend on ${target} ` +
            `(layer ${toLayer}); dependencies must point strictly downward`,
        );
      }
      const forbidden = FORBIDDEN.find((rule) => rule.from === manifest.name && rule.to === target);
      if (forbidden !== undefined) {
        violations.push(
          `${origin}: ${forbidden.from} -> ${forbidden.to} is forbidden: ${forbidden.why}`,
        );
      }
      if (declared !== null && !declared.has(target)) {
        violations.push(`${origin}: reaches ${target} without declaring it as a dependency`);
      }
    };

    for (const dependency of manifest.dependencies) {
      check(dependency, `${path.relative(ROOT, manifest.dir)}package.json`, null);
    }

    const declared = new Set(manifest.dependencies);
    for (const file of await sourceFiles(path.join(manifest.dir, 'src'))) {
      const origin = path.relative(ROOT, file);
      const parsed = specifiersIn(file, await readFile(file, 'utf8'));
      for (const unresolved of parsed.dynamic) {
        violations.push(
          `${origin}: ${unresolved} has a non-literal specifier that cannot be checked`,
        );
      }
      for (const specifier of parsed.specifiers) {
        if (specifier.startsWith('@capitaldesk/')) {
          // Normalise a subpath export such as "@capitaldesk/contracts/fixtures/x.json".
          const target = specifier.split('/').slice(0, 2).join('/');
          check(target, origin, declared);
          continue;
        }
        if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
          // A relative or absolute path that lands inside another workspace package is the
          // same boundary crossing as naming that package, and must be treated identically.
          const resolved = path.resolve(path.dirname(file), specifier);
          const owner = ownerOf(manifests, resolved);
          if (owner !== null && owner.name !== manifest.name) {
            check(owner.name, `${origin} (via path "${specifier}")`, declared);
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write(`dependency layering violations:\n  - ${violations.join('\n  - ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `dependency layering OK (${manifests.length} workspace packages, ${crossings} crossings checked)\n`,
  );
}

await main();
