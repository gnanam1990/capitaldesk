import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

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
  ['@capitaldesk/config', '@capitaldesk/observability'],
  ['@capitaldesk/db'],
  ['@capitaldesk/api', '@capitaldesk/worker', '@capitaldesk/executor', '@capitaldesk/web'],
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
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next')
        continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

/**
 * Every module specifier in a file: static imports, re-exports and dynamic import calls.
 * `export ... from` is a crossing exactly like `import ... from`, and the probe that
 * defeated the previous checker used precisely that form.
 */
const SPECIFIER_PATTERN =
  /(?:\bimport\b|\bexport\b)[\s\S]{0,400}?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;

function specifiersIn(text: string): readonly string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
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
      for (const specifier of specifiersIn(await readFile(file, 'utf8'))) {
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
