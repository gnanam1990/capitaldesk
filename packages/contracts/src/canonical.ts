import { createHash } from 'node:crypto';
import { violate } from './errors.js';

/**
 * Canonical encoding and content digests.
 *
 * Approval binds an exact payload (INV-08), so the encoding must be total, deterministic
 * and independent of key insertion order. Anything that could encode two different
 * meanings into the same bytes — or the same meaning into two different byte strings — is
 * refused rather than normalized.
 */

export type CanonicalValue =
  string | boolean | null | CanonicalValue[] | { readonly [key: string]: CanonicalValue };

/**
 * Canonical JSON.
 *
 * Rules: object keys sorted by UTF-16 code unit; no `undefined`; no numbers at all —
 * quantities are atom strings and counts are decimal strings, so a JSON number can never
 * silently lose precision; no NaN/Infinity; no cycles.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>(), '$');
}

function encode(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return violate(
        'CANONICAL_ENCODING_REJECTED',
        'JSON numbers are not permitted in canonical payloads; encode as an exact string',
        { path, value: String(value) },
      );
    case 'bigint':
      return violate(
        'CANONICAL_ENCODING_REJECTED',
        'encode bigint as an explicit atom string before canonicalisation',
        { path, value: value.toString() },
      );
    case 'undefined':
      return violate(
        'CANONICAL_ENCODING_REJECTED',
        'undefined has no canonical encoding; omit the key or encode null',
        { path },
      );
    case 'function':
    case 'symbol':
      return violate(
        'CANONICAL_ENCODING_REJECTED',
        `values of type ${typeof value} are not encodable`,
        { path },
      );
    case 'object':
      // Objects and arrays are traversed below; `null` returned earlier.
      break;
  }

  // Narrowed to a non-null object by the switch above.
  const object: object = value;
  if (seen.has(object)) {
    violate('CANONICAL_ENCODING_REJECTED', 'canonical payloads must be acyclic', { path });
  }
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        // A sparse array is refused rather than encoded. `[,,]` is not valid JSON, and
        // silently dropping holes would make `new Array(1)` and `[]` share a digest — two
        // different payloads with one approval signature.
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          violate(
            'CANONICAL_ENCODING_REJECTED',
            'sparse arrays have no canonical encoding; array holes are not permitted',
            { path: `${path}[${index}]`, length: String(value.length) },
          );
        }
        items.push(encode(value[index], seen, `${path}[${index}]`));
      }
      return `[${items.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      violate(
        'CANONICAL_ENCODING_REJECTED',
        'only plain objects and arrays are canonically encodable',
        { path },
      );
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => {
      const encoded = encode(record[key], seen, `${path}.${key}`);
      return `${JSON.stringify(key)}:${encoded}`;
    });
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/** A content digest of the canonical encoding, formatted `sha256:<64 lowercase hex>`. */
export function digestOf(value: unknown): string {
  const hash = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Refuse an object carrying any key outside `allowed`.
 *
 * Digest payload builders read a fixed field list, so an unexpected key would otherwise be
 * silently dropped and two materially different payloads would share one digest. Callers
 * that bind an approval MUST run this over the input object and every nested object before
 * building the payload.
 */
export function assertOnlyKnownKeys(value: object, allowed: readonly string[], path: string): void {
  const permitted = new Set<string>(allowed);
  const unexpected = Object.keys(value).filter((key) => !permitted.has(key));
  if (unexpected.length > 0) {
    const named = unexpected.sort().join(', ');
    violate(
      'CANONICAL_ENCODING_REJECTED',
      `${path} carries keys outside the frozen field list: ${named}. A decision-changing ` +
        'field must never bypass the digest.',
      { path, unexpected: named, allowed: [...permitted].sort().join(',') },
    );
  }
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

/** Constant-time-ish digest comparison. Digests are public, but mismatch must be exact. */
export function digestEquals(a: string, b: string): boolean {
  return a.length === b.length && a === b;
}
