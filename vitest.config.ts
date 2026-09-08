import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Resolve workspace packages to their TypeScript source, not their build output.
 *
 * Each package's `exports` field points at `dist/`, which does not exist in a fresh checkout.
 * Tests therefore only passed on a machine that had already built, and a focused command such
 * as `vitest run --project unit packages/domain` failed on a cold tree with "Failed to resolve
 * entry for @capitaldesk/contracts". Worse than failing, it could have passed against a stale
 * `dist/` that no longer matched the source under test.
 *
 * Aliasing to source removes both: every test run reads the same files the typechecker does,
 * with no build step and nothing stale to read.
 */
const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

const workspaceAliases = {
  '@capitaldesk/contracts': packageSource('contracts'),
  '@capitaldesk/domain': packageSource('domain'),
  '@capitaldesk/config': packageSource('config'),
  '@capitaldesk/observability': packageSource('observability'),
  '@capitaldesk/db': packageSource('db'),
};

/**
 * Evidence classes are separate projects, never one blended suite (TEST-PLAN section 1).
 *
 *  - unit:     deterministic reference models and fixtures.
 *  - property: generated cases with recorded seeds.
 *
 * Integration (real PostgreSQL, real processes) and external venue proof are separate
 * projects that arrive with the code they exercise. They are absent here rather than
 * present and empty, so a green run never implies coverage that does not exist.
 */
export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    projects: [
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tools/**/*.test.ts'],
          // Evidence classes must not blend: an integration file selected here would be
          // reported as a skip inside the unit run and read as unit coverage that is merely
          // unconfigured.
          exclude: ['**/*.property.test.ts', '**/*.integration.test.ts', '**/node_modules/**'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'property',
          include: ['packages/*/src/**/*.property.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'integration',
          // Real PostgreSQL, real processes. Skips itself with a clear message when
          // CAPITALDESK_TEST_DATABASE_URL is absent, and is never silently counted as
          // passing coverage it did not exercise.
          include: [
            'packages/*/src/**/*.integration.test.ts',
            'apps/*/src/**/*.integration.test.ts',
          ],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
    ],
  },
});
