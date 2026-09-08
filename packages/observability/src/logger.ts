import { pino, type Logger } from 'pino';
import { redact } from './redaction.js';

export interface LoggerOptions {
  readonly role: 'api' | 'worker' | 'executor' | 'web';
  readonly level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly buildId: string;
  readonly deploymentEnvironment: string;
  readonly accountAlias: string;
}

/**
 * A structured logger whose every payload passes through redaction first.
 *
 * Correlation fields (role, build, environment, account alias) are bound at construction so
 * a log line can always be tied back to a deployment without carrying credential material.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: {
      role: options.role,
      buildId: options.buildId,
      env: options.deploymentEnvironment,
      accountAlias: options.accountAlias,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      log(object: Record<string, unknown>): Record<string, unknown> {
        return redact(object) as Record<string, unknown>;
      },
    },
  });
}

export type { Logger };
