import { redactText } from '@capitaldesk/observability';

/**
 * What may be written into `audit_events.detail`.
 *
 * The logger's redaction boundary does not reach this column: audit detail goes straight to
 * PostgreSQL, and a secret written there is durable, exportable and outside the sink that
 * scrubs log records. Nor is value-shape redaction sufficient on its own — an Argon2id-hashed
 * password's plaintext, or a 43-character base64url agent secret, matches no known secret
 * pattern. Either would survive a scrubber and land in the audit trail intact.
 *
 * So the boundary here is a closed schema rather than a filter: each permitted key declares
 * the exact shape of its value, and anything else is dropped before the INSERT. A token, a
 * password or a signed URL cannot satisfy any of these shapes, so none of them can be
 * persisted regardless of the key a caller puts it under.
 *
 * Only the key *names* of rejected entries are recorded, never their values, so a mistake is
 * visible to whoever reads the trail without the mistake becoming the leak.
 */

/** Our own identifiers and refusal codes. None of these shapes can hold a secret. */
const AUDIT_DETAIL_SHAPES = {
  credentialId: /^cred-[A-Za-z0-9_-]{1,43}$/,
  rotatedFrom: /^cred-[A-Za-z0-9_-]{1,43}$/,
  enrollmentId: /^enr-[A-Za-z0-9_-]{1,43}$/,
  supersededEnrollmentId: /^enr-[A-Za-z0-9_-]{1,43}$/,
  supersededReason: /^(expired|rotated)$/,
  userId: /^usr-[A-Za-z0-9_-]{1,43}$/,
  loginName: /^[a-z0-9][a-z0-9._-]{2,63}$/,
  /** A capability or action name, e.g. `credential.rotate`. */
  capability: /^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)*$/,
  /** One of our own refusal codes, e.g. `WRONG_CODE`. Screaming snake case only. */
  refusal: /^[A-Z][A-Z_]{1,47}$/,
  /** A short human phrase, e.g. `owner revoked`. Lower case, so no identifier or token fits. */
  reason: /^[a-z][a-z0-9 -]{0,63}$/,
} as const satisfies Record<string, RegExp>;

/** Secret encodings this system produces: the agent token grammar and an Argon2 digest. */
const MINTED_SECRET_SHAPES: readonly RegExp[] = [/^cdk_/, /\$argon2/];

export type AuditDetailKey = keyof typeof AUDIT_DETAIL_SHAPES;

export type AuditDetail = Partial<Record<AuditDetailKey, string | null>>;

/** How many entries the schema refused. A count, never the names. */
export const REJECTED_COUNT_FIELD = 'rejectedDetailCount';

export interface SanitizedAuditDetail {
  readonly detail: Record<string, string>;
  /** Names only. Present so a dropped field is visible without its value being persisted. */
  readonly rejectedKeys: readonly string[];
}

/**
 * Reduce a caller's detail to what the schema permits.
 *
 * Null values are dropped rather than stored: `{"supersededReason": null}` says nothing that
 * the key's absence does not already say.
 */
export function sanitizeAuditDetail(
  detail: Readonly<Record<string, unknown>>,
): SanitizedAuditDetail {
  const output: Record<string, string> = {};
  const rejectedKeys: string[] = [];

  for (const [key, value] of Object.entries(detail)) {
    if (value === null || value === undefined) continue;

    const shape = (AUDIT_DETAIL_SHAPES as Record<string, RegExp | undefined>)[key];
    if (shape === undefined || typeof value !== 'string' || !shape.test(value)) {
      rejectedKeys.push(key);
      continue;
    }
    // A named refusal for the two secret encodings this system mints itself. No shape above
    // admits either today; this is here so that widening one later cannot open the channel
    // silently, which is exactly how the first version of `reason` nearly did.
    if (MINTED_SECRET_SHAPES.some((pattern) => pattern.test(value))) {
      rejectedKeys.push(key);
      continue;
    }
    // Defence in depth behind the schema, not instead of it. No current shape admits a value
    // this scrubber would alter — it catches a future widening, not today's inputs.
    output[key] = redactText(value);
  }

  if (rejectedKeys.length > 0) {
    // A count, not the names. Object keys are caller-controlled and can be arbitrary strings,
    // so writing the rejected key names into the column recreated the exact leak the schema
    // exists to prevent - a secret passed as a *key* would have been persisted verbatim. The
    // names are still returned to the caller for logging behind the redacting sink; only the
    // durable column is restricted.
    output[REJECTED_COUNT_FIELD] = String(rejectedKeys.length);
  }
  return { detail: output, rejectedKeys };
}
