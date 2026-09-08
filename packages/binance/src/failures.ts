import { ContractViolation, violate } from '@capitaldesk/contracts';
import { redactText } from './redaction.js';
import type { ReadEndpointName } from './endpoints.js';

/**
 * A failed read is a typed fact, never an empty success (prompt 05 task 3).
 *
 * The classes are separate because their correct responses are separate: back off until a
 * named instant, treat the source as degraded and preserve reservations, quarantine an
 * unrecognised fact for an owner, or apply a venue rule that depends on the exact error code.
 * Collapsing them into one error — or worse, into `[]` — is how a reconciler concludes that an
 * account has no trades and releases capital it should have held.
 */
export class ReadFailure extends ContractViolation {
  readonly endpoint: ReadEndpointName;
  /** HTTP status, where the failure had one. */
  readonly status: number | null;
  /** Seconds the venue asked us to wait, when it sent a usable Retry-After. */
  readonly retryAfterSeconds: number | null;
  /** The venue's own error code, e.g. -2013 "Order does not exist." */
  readonly venueCode: number | null;

  constructor(
    reason: ConstructorParameters<typeof ContractViolation>[0],
    message: string,
    fields: {
      readonly endpoint: ReadEndpointName;
      readonly status?: number | null;
      readonly retryAfterSeconds?: number | null;
      readonly venueCode?: number | null;
      readonly detail?: Readonly<Record<string, string>>;
    },
  ) {
    super(reason, message, {
      endpoint: fields.endpoint,
      ...(fields.status === undefined || fields.status === null
        ? {}
        : { status: String(fields.status) }),
      ...(fields.venueCode === undefined || fields.venueCode === null
        ? {}
        : { venueCode: String(fields.venueCode) }),
      ...fields.detail,
    });
    this.name = 'ReadFailure';
    this.endpoint = fields.endpoint;
    this.status = fields.status ?? null;
    this.retryAfterSeconds = fields.retryAfterSeconds ?? null;
    this.venueCode = fields.venueCode ?? null;
  }
}

/**
 * The largest Retry-After this reader will honour.
 *
 * The venue documents IP bans that "scale in duration for repeat offenders, from 2 minutes to
 * 3 days", and Retry-After on a 418 gives the seconds until the ban is over. Three days is
 * therefore a legitimate instruction, not an absurd one. An earlier version capped at an hour
 * and returned null above it, which is the dangerous direction: null leaves the caller with no
 * instruction, so it retries early, into the ban that is lengthening because of it.
 */
export const MAX_RETRY_AFTER_SECONDS = 3 * 24 * 60 * 60;

/** Conservative waits for a rate limit that arrived with no usable header. */
const DEFAULT_DEFER_SECONDS: Readonly<Record<'429' | '418' | 'other', number>> = {
  // The documented minimum ban is two minutes; a 418 with no header waits at least that.
  '418': 120,
  '429': 30,
  other: 30,
};

/**
 * Seconds from a `Retry-After` header, or null when there is no usable instruction.
 *
 * Only the documented delay-seconds form is accepted, as a bounded non-negative integer.
 * `null` means "the venue told us nothing", which callers must treat as a reason to apply
 * their own conservative floor — never as permission to retry immediately.
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  // Strictly digits: this rejects '-5', '1.5', '1e3', 'NaN' and 'Infinity' without relying on
  // Number() coercion, which accepts all but the first.
  if (!/^\d+$/.test(text)) return null;
  return usableDeferSeconds(Number(text));
}

/**
 * The one place a defer duration is judged, whatever route it arrived by.
 *
 * `parseRetryAfter` is not the only way a number reaches a failure: `rateLimited` is exported
 * and a caller can pass one directly. Leaving the bound in the parser alone meant
 * `rateLimited('account', 429, -1)` scheduled a retry in the past and `Infinity` produced an
 * Invalid Date, which is stored as null and reads as "never" — the opposite of a wait.
 */
export function usableDeferSeconds(seconds: number | null | undefined): number | null {
  if (seconds === null || seconds === undefined) return null;
  if (!Number.isInteger(seconds)) return null;
  if (seconds < 0 || seconds > MAX_RETRY_AFTER_SECONDS) return null;
  return seconds;
}

/**
 * The instant this failure may next be retried, or null when it is not a rate limit.
 *
 * An absolute instant, not a duration, because a three-day defer must survive a restart and
 * must never be slept through: blocking a worker for three days is an outage, not a backoff.
 * The caller persists this and lets the scheduler decide when to look again.
 */
export function deferUntil(failure: ReadFailure, now: Date): Date | null {
  if (failure.reason !== 'SOURCE_RATE_LIMITED') return null;
  const base = now.getTime();
  if (!Number.isFinite(base)) {
    violate('CLOCK_SKEW_UNBOUNDED', 'cannot compute a defer instant from an invalid clock', {
      endpoint: failure.endpoint,
    });
  }
  const key = failure.status === 418 ? '418' : failure.status === 429 ? '429' : 'other';
  const seconds = failure.retryAfterSeconds ?? DEFAULT_DEFER_SECONDS[key];
  const epoch = base + seconds * 1000;
  const until = new Date(epoch);
  // The inputs being sound does not make the result sound: a clock already near the ECMAScript
  // time-value limit plus a legitimate three-day defer lands outside it, and `new Date` answers
  // with an Invalid Date whose `getTime()` is NaN. Persisted, that reads as "never", which is
  // the opposite of a wait. Refuse it here rather than storing it.
  if (!Number.isFinite(epoch) || Number.isNaN(until.getTime())) {
    violate('CLOCK_SKEW_UNBOUNDED', 'the computed defer instant is not a representable time', {
      endpoint: failure.endpoint,
      seconds: String(seconds),
    });
  }
  return until;
}

/**
 * Whether retrying this failure could succeed.
 *
 * A 418 is an auto-ban, not a warning: retrying through one is exactly what lengthens it, so
 * it is never retryable here even though it carries a wait. The scheduler resumes it from the
 * persisted defer instant instead.
 */
export function isRetryable(failure: ReadFailure): boolean {
  if (failure.reason === 'SOURCE_UNAVAILABLE') return true;
  return failure.reason === 'SOURCE_RATE_LIMITED' && failure.status !== 418;
}

/** HTTP 429 or 418. */
export function rateLimited(
  endpoint: ReadEndpointName,
  status: number,
  retryAfterSeconds: number | null,
): ReadFailure {
  // Every route into a failure passes through the same bound. An out-of-range value becomes
  // null, which means "the venue gave no usable instruction" and makes the caller apply its
  // conservative floor — never a negative wait, and never a non-finite one.
  return new ReadFailure(
    'SOURCE_RATE_LIMITED',
    `${endpoint} was rate limited with HTTP ${String(status)}`,
    { endpoint, status, retryAfterSeconds: usableDeferSeconds(retryAfterSeconds) },
  );
}

/** Transport failure, timeout or 5xx: the fact is unknown, never absent. */
export function unavailable(
  endpoint: ReadEndpointName,
  cause: string,
  status: number | null = null,
): ReadFailure {
  // Redacted before it reaches the message, not only the detail. An unhandled rejection prints
  // `Error.message`, and a transport error routinely quotes the URL it failed on — signed
  // query string and all.
  const safe = redactText(cause, []);
  return new ReadFailure('SOURCE_UNAVAILABLE', `${endpoint} could not be read: ${safe}`, {
    endpoint,
    status,
    detail: { cause: safe },
  });
}

/** The response did not decode against the narrow schema. */
export function schemaUnrecognized(endpoint: ReadEndpointName, what: string): ReadFailure {
  // Same reasoning as `unavailable`: a decoder message can quote the value it choked on.
  const safe = redactText(what, []);
  return new ReadFailure(
    'SOURCE_SCHEMA_UNRECOGNIZED',
    `${endpoint} returned a shape this build does not recognise: ${safe}`,
    { endpoint, detail: { what: safe } },
  );
}

/**
 * The venue rejected the request with its own `{code, msg}` envelope.
 *
 * The code is kept because callers apply rules to it. A single -2013 "Order does not exist."
 * must never release a reservation (T-029), and that rule can only be applied by a caller that
 * can see which code it was.
 */
export function venueRejected(
  endpoint: ReadEndpointName,
  code: number,
  message: string,
  status: number | null = 400,
): ReadFailure {
  const safe = redactText(message, []);
  return new ReadFailure(
    'VENUE_OBSERVATION_UNSUPPORTED',
    `${endpoint} was rejected by the venue: ${safe}`,
    { endpoint, status, venueCode: code, detail: { venueMessage: safe } },
  );
}
