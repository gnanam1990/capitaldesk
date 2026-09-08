import { violate } from './errors.js';

/**
 * Credential classes (ADR-0007).
 *
 * The original pack said secrets are mounted only into the executor, while the account
 * reader also needs authenticated access. These are three separate secret classes with
 * separate identities and separate mount points. A reader is never granted TRADE.
 */
export const CREDENTIAL_CLASSES = [
  /** Binance USER_DATA (read) permission. Mounted only into the account-reader process. */
  'VENUE_READ',
  /** Binance TRADE permission. Mounted only into the executor process. */
  'VENUE_TRADE',
  /** Owner web/API session signing secret. Mounted only into the API process. */
  'OWNER_SESSION',
  /** Hashed agent proposal credentials. Never a venue secret. */
  'AGENT_PROPOSAL',
] as const;
export type CredentialClass = (typeof CREDENTIAL_CLASSES)[number];

export const PROCESS_ROLES = ['api', 'worker', 'executor', 'web'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

/** The only permitted mounts. Anything absent from this table is denied. */
const PERMITTED_MOUNTS: Readonly<Record<ProcessRole, readonly CredentialClass[]>> = Object.freeze({
  api: ['OWNER_SESSION', 'AGENT_PROPOSAL'],
  worker: ['VENUE_READ'],
  executor: ['VENUE_TRADE'],
  web: [],
});

export function mayMount(role: ProcessRole, credential: CredentialClass): boolean {
  return PERMITTED_MOUNTS[role].includes(credential);
}

export function assertMayMount(role: ProcessRole, credential: CredentialClass): void {
  if (!mayMount(role, credential)) {
    violate('AUTHZ_CREDENTIAL_CLASS_DENIED', 'credential class is not mountable in this role', {
      role,
      credential,
    });
  }
}

/**
 * The read and trade credentials must resolve to the same stable authenticated account.
 * A mismatch means we would reconcile one account and trade another (ADR-0007).
 */
export function assertReaderAndTraderMatch(
  readerStableAccountId: string,
  traderStableAccountId: string,
): void {
  // Two absent identities are not a match. Comparing them directly let the gate pass when
  // neither credential had established an account at all — the case it exists to catch.
  const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  for (const [role, id] of [
    ['reader', readerStableAccountId],
    ['trader', traderStableAccountId],
  ] as const) {
    // Same segment rules as venueAccountKey: whitespace-only, padded and malformed ids are
    // not identities, and two of them are certainly not the same identity.
    if (id.trim().length > 0 && !ACCOUNT_ID_PATTERN.test(id)) {
      violate('IDENTITY_UNSTABLE_ACCOUNT', `the ${role} account id is malformed`, { role });
    }
    if (id.trim().length === 0) {
      violate('IDENTITY_UNSTABLE_ACCOUNT', `the ${role} credential established no account id`, {
        role,
      });
    }
  }
  if (readerStableAccountId !== traderStableAccountId) {
    violate(
      'IDENTITY_UNSTABLE_ACCOUNT',
      'read and trade credentials resolve to different venue accounts',
      { reader: readerStableAccountId, trader: traderStableAccountId },
    );
  }
}
