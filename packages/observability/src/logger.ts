import { pino, destination as pinoDestination, type DestinationStream, type Logger } from 'pino';
import { redact, redactText } from './redaction.js';

export interface LoggerOptions {
  readonly role: 'api' | 'worker' | 'executor' | 'web';
  readonly level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly buildId: string;
  readonly deploymentEnvironment: string;
  readonly accountAlias: string;
  /** Test seam. Defaults to stdout. */
  readonly destination?: DestinationStream;
}

/**
 * Redaction has to hold at the sink, not at one entrypoint.
 *
 * `formatters.log` only sees the merged object argument. It does not see the message string,
 * interpolation arguments, child bindings or the base bindings, so a logger configured with
 * it alone leaks through every other call form — which is exactly what independent probing
 * found: `log.info(\`... ${secret}\`)`, `log.child({ apiKey })` and the base bindings all
 * reached the output untouched while only `log.info({ apiKey }, 'msg')` was redacted.
 *
 * Three layers now cover the whole surface:
 *
 *  1. `hooks.logMethod` intercepts every call, so message strings, interpolation arguments
 *     and object arguments are redacted before Pino formats them.
 *  2. `formatters.log` and pre-redacted base bindings handle the structured paths, so
 *     key-name redaction (`apiKey`, `authorization`, …) applies to fields whose values are
 *     not themselves secret-shaped.
 *  3. The destination is wrapped, so the serialized line is scrubbed for secret-shaped values
 *     regardless of which path produced it. This is the backstop that makes the guarantee
 *     testable at the sink: no matter what a caller does, the bytes written are scrubbed.
 *
 * Layer 3 alone is not enough — it matches value *shapes*, so a low-entropy secret under a
 * revealing key name would survive it. Layer 1 and 2 alone are not enough either, as the
 * probe showed. The three together are why the tests assert on captured output rather than
 * on the `redact()` helper.
 */
/**
 * Redact `child()` bindings.
 *
 * `formatters.bindings` is applied to the base bindings, not to child bindings: Pino
 * serializes those when the child is created. So a child binding whose value is not
 * secret-*shaped* — a low-entropy password under a revealing key — would survive both the
 * formatter and the sink scrub. Wrapping `child` closes that path, and re-wrapping the
 * result keeps it closed for grandchildren.
 */
function withRedactedChild(logger: Logger): Logger {
  const createChild = logger.child.bind(logger) as unknown as (
    bindings: Record<string, unknown>,
    options?: unknown,
  ) => Logger;

  Object.defineProperty(logger, 'child', {
    configurable: true,
    writable: true,
    value: (bindings: Record<string, unknown>, options?: unknown): Logger =>
      withRedactedChild(createChild(redact(bindings) as Record<string, unknown>, options)),
  });

  return logger;
}

function redactingDestination(inner: DestinationStream): DestinationStream {
  return {
    write(line: string): void {
      inner.write(redactText(line));
    },
  };
}

export function createLogger(options: LoggerOptions): Logger {
  const destination = options.destination ?? pinoDestination({ dest: 1, sync: true });

  return withRedactedChild(
    pino(
      {
        level: options.level,
        // Base bindings are serialized once at construction and never pass through
        // formatters.log, so they are redacted here.
        base: redact({
          role: options.role,
          buildId: options.buildId,
          env: options.deploymentEnvironment,
          accountAlias: options.accountAlias,
        }) as Record<string, unknown>,
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
          log(object: Record<string, unknown>): Record<string, unknown> {
            return redact(object) as Record<string, unknown>;
          },
          bindings(bindings: Record<string, unknown>): Record<string, unknown> {
            return redact(bindings) as Record<string, unknown>;
          },
        },
        hooks: {
          logMethod(args: unknown[], method): void {
            // Covers the message string, printf-style interpolation arguments and any object
            // argument — every form a caller can reach at write time.
            const redacted = args.map((argument) =>
              typeof argument === 'string' ? redactText(argument) : redact(argument),
            );
            method.apply(this, redacted as Parameters<typeof method>);
          },
        },
      },
      redactingDestination(destination),
    ),
  );
}

export type { Logger };
