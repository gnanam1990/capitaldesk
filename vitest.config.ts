import { defineConfig } from 'vitest/config';

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
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tools/**/*.test.ts'],
          exclude: ['**/*.property.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'property',
          include: ['packages/*/src/**/*.property.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          // Real PostgreSQL, real processes. Skips itself with a clear message when
          // CAPITALDESK_TEST_DATABASE_URL is absent, and is never silently counted as
          // passing coverage it did not exercise.
          include: ['packages/*/src/**/*.integration.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
    ],
  },
});
