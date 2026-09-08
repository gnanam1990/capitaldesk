import { Client } from 'pg';
import { parseArguments, USAGE } from './args.js';
import { issueEnrollment, redeemEnrollment } from './enroll.js';
import { InputInterrupted, InputSession } from './input-session.js';

/**
 * Operator entry point for one-time owner enrollment.
 *
 * Secrets are read from stdin, never from argv: an argument is visible in `ps` output and in
 * the operator's shell history, and a bootstrap code that leaks there is not single-use in any
 * meaningful sense. The parser refuses a secret-shaped flag outright rather than ignoring it.
 *
 * Argument and policy checks both happen before any database connection is opened, and the
 * policy checks live in `issueEnrollment`/`redeemEnrollment` rather than here, so a second
 * caller of those functions cannot reach a weaker path.
 */

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === 'usage') {
    process.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    process.stderr.write('DATABASE_URL is required\n');
    process.exitCode = EXIT_USAGE;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (parsed.kind === 'issue') {
      const outcome = await issueEnrollment(client, {
        workspaceId: parsed.workspaceId,
        loginName: parsed.loginName,
        rotate: parsed.rotate,
      });
      if (!outcome.ok) {
        process.stderr.write(`refused: ${outcome.reason}\n`);
        if (outcome.reason === 'LIVE_ENROLLMENT_OUTSTANDING') {
          process.stderr.write(
            'a live code is already outstanding; pass --rotate to withdraw it deliberately\n',
          );
        }
        process.exitCode = EXIT_REFUSED;
        return;
      }
      if (outcome.superseded !== null) {
        process.stderr.write(
          `withdrew ${outcome.superseded.enrollmentId} (${outcome.superseded.reason})\n`,
        );
      }
      process.stderr.write(
        `enrollment ${outcome.enrollmentId} expires ${outcome.expiresAt.toISOString()}\n`,
      );
      // The single intended display, written exactly once and nowhere else.
      process.stdout.write(`${outcome.code}\n`);
      return;
    }

    const session = new InputSession({
      input: process.stdin,
      // Prompts and echo go to stderr so stdout stays reserved for the enrollment code.
      output: process.stderr,
      interactive: process.stdin.isTTY === true,
    });
    // Restore the terminal if the operator interrupts mid-prompt, rather than leaving a shell
    // in raw mode with echo off.
    const onSignal = (): void => {
      session.close();
      process.exit(EXIT_INTERRUPTED);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    let code: string;
    let password: string;
    try {
      // Both hidden. The enrollment code authenticates the redemption — it is a bearer
      // secret, not a username — so echoing it to the terminal would leave it on screen, in
      // scrollback and in any terminal recording, which is the same exposure the password
      // read avoids.
      code = await session.read('enrollment code: ', true);
      password = await session.read('new owner password: ', true);
    } catch (error) {
      // On a terminal, readline consumes Ctrl-C and the process handler never ran, so an
      // interrupt used to look like an empty answer and was reported as a weak password.
      if (error instanceof InputInterrupted) {
        process.stderr.write('\ninterrupted\n');
        process.exitCode = EXIT_INTERRUPTED;
        return;
      }
      throw error;
    } finally {
      session.close();
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }

    const outcome = await redeemEnrollment(client, {
      workspaceId: parsed.workspaceId,
      code,
      password,
    });
    if (!outcome.ok) {
      process.stderr.write(`refused: ${outcome.reason}\n`);
      process.exitCode = EXIT_REFUSED;
      return;
    }
    process.stderr.write(`enrolled ${outcome.loginName} as owner (${outcome.userId})\n`);
  } finally {
    await client.end();
  }
}

await main();
