import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { loadMigrations, migrate, migrationStatus } from './migrator.js';

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
    if (command === 'status') {
      const status = await migrationStatus(client, files);
      for (const row of status) {
        const state = row.applied
          ? row.checksumMatches
            ? 'applied'
            : 'CHECKSUM MISMATCH'
          : 'pending';
        process.stdout.write(`${row.version}\t${state}\n`);
      }
      if (status.some((row) => row.checksumMatches === false)) process.exitCode = 1;
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
    process.stderr.write(`unknown command: ${command} (expected "migrate" or "status")\n`);
    process.exitCode = 2;
  } finally {
    await client.end();
  }
}

await main();
