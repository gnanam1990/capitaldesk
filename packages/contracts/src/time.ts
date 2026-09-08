import { violate } from './errors.js';

/**
 * One strict UTC instant parser, used everywhere an instant is bound to an economic decision.
 *
 * Two failures made this necessary. `Date.parse` accepts a timezone-less string and resolves
 * it in the *host's* local zone, so two executors on differently configured hosts derived
 * different deadlines from the same approval. And it silently normalises an impossible
 * calendar day: `2026-02-30T12:00:00.000Z` becomes 2 March rather than being rejected, so a
 * digest could bind an instant that does not exist.
 *
 * A shape check alone does not catch the second — `2026-02-30` matches any reasonable regex.
 * The round-trip is what settles it: parse the components, rebuild the instant in UTC, and
 * require every component to survive unchanged.
 */
const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export interface StrictUtcInstant {
  readonly iso: string;
  readonly epochMs: number;
}

export function isStrictUtcInstant(text: string): boolean {
  return parseStrictUtcInstantOrNull(text) !== null;
}

function parseStrictUtcInstantOrNull(text: string): StrictUtcInstant | null {
  const match = ISO_UTC_PATTERN.exec(text);
  if (match === null) return null;

  const [, year, month, day, hour, minute, second, fraction] = match;
  const ms = fraction === undefined ? 0 : Number(fraction.padEnd(3, '0'));
  const epochMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    ms,
  );
  if (Number.isNaN(epochMs)) return null;

  // Round-trip: an impossible calendar day is normalised by Date.UTC, so a component that
  // changed proves the input named an instant that does not exist.
  const rebuilt = new Date(epochMs);
  const survived =
    rebuilt.getUTCFullYear() === Number(year) &&
    rebuilt.getUTCMonth() === Number(month) - 1 &&
    rebuilt.getUTCDate() === Number(day) &&
    rebuilt.getUTCHours() === Number(hour) &&
    rebuilt.getUTCMinutes() === Number(minute) &&
    rebuilt.getUTCSeconds() === Number(second) &&
    rebuilt.getUTCMilliseconds() === ms;

  return survived ? { iso: text, epochMs } : null;
}

/** Parse, or refuse. Never normalises, never falls back to the host timezone. */
export function parseStrictUtcInstant(name: string, text: string): StrictUtcInstant {
  const parsed = parseStrictUtcInstantOrNull(text);
  if (parsed === null) {
    violate(
      'IDENTITY_MALFORMED',
      `${name} must be a real ISO-8601 UTC instant ending in Z (no local-time form, no impossible date)`,
      { [name]: text },
    );
  }
  return parsed;
}

/** Milliseconds since the epoch, for an instant that must be valid. */
export function strictUtcMs(name: string, text: string): number {
  return parseStrictUtcInstant(name, text).epochMs;
}

/** An ordered, non-empty interval of strict UTC instants. */
export interface Interval {
  readonly from: string;
  readonly to: string;
}

export function assertOrderedInterval(name: string, interval: Interval): void {
  const from = strictUtcMs(`${name}.from`, interval.from);
  const to = strictUtcMs(`${name}.to`, interval.to);
  if (from >= to) {
    violate('IDENTITY_MALFORMED', `${name} must start strictly before it ends`, {
      from: interval.from,
      to: interval.to,
    });
  }
}

/** Whether `outer` fully contains `inner`. Both must already be ordered intervals. */
export function covers(outer: Interval, inner: Interval): boolean {
  return (
    strictUtcMs('outer.from', outer.from) <= strictUtcMs('inner.from', inner.from) &&
    strictUtcMs('outer.to', outer.to) >= strictUtcMs('inner.to', inner.to)
  );
}
