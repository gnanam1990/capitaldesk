import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { loadMigrations, migrate, migrationStatus } from './migrator.js';
import { enterRestorePostureOn } from './journal/restore.js';
import { authorizeRestoreCommand } from './restore-command.js';

/**
 * Migration CLI. `migrate` applies pending forward migrations; `status` reports without
 * writing. Neither command can drop, truncate or reset a database.
 */
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    process.stderr.write('DATABASE_URL is required\n');
    process.exitCode = 2;
    return;
  }

  const files = await loadMigrations(MIGRATIONS_DIR);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (command === 'restore-posture') {
      const authorization = authorizeRestoreCommand(process.env);
      const posture = await enterRestorePostureOn(client, {
        reason: authorization.reason,
        now: new Date(),
      });
      process.stdout.write(`${JSON.stringify({ state: 'HALTED_RECONCILING', ...posture })}\n`);
      return;
    }
    if (command === 'status') {
      // Read-only: this runs inside an explicit READ ONLY transaction so a reporting command
      // can never write, including creating its own bookkeeping table.
      await client.query('BEGIN READ ONLY');
      let report;
      try {
        report = await migrationStatus(client, files);
      } finally {
        await client.query('ROLLBACK');
      }

      if (!report.bookkeepingExists) {
        process.stdout.write('schema_migrations does not exist; no migration has been applied\n');
      }
      for (const row of report.migrations) {
        const state = row.applied
          ? row.checksumMatches
            ? 'applied'
            : 'CHECKSUM MISMATCH'
          : 'pending';
        process.stdout.write(`${row.version}\t${state}\n`);
      }
      for (const version of report.appliedNotSupplied) {
        process.stdout.write(`${version}\tAPPLIED BUT NOT SHIPPED BY THIS BUILD\n`);
      }
      for (const divergence of report.divergences) {
        process.stderr.write(`${divergence.version}\t${divergence.kind}: ${divergence.detail}\n`);
      }
      if (report.divergences.length > 0) process.exitCode = 1;
      return;
    }
    if (command === 'migrate') {
      const result = await migrate(client, files, {
        appliedBy: process.env['USER'] ?? 'unknown',
        buildId: process.env['CAPITALDESK_BUILD_ID'] ?? 'dev',
      });
      for (const version of result.alreadyApplied) process.stdout.write(`${version}\tskipped\n`);
      for (const version of result.applied) process.stdout.write(`${version}\tapplied\n`);
      return;
    }
    process.stderr.write(
      `unknown command: ${command} (expected "migrate", "status" or "restore-posture")\n`,
    );
    process.exitCode = 2;
  } finally {
    await client.end();
  }
}

await main();
