import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * Hashing and secret generation.
 *
 * No cryptography is invented here: Argon2id comes from @node-rs/argon2 and the digests come
 * from node:crypto. What this module owns is the *choice* of parameters and formats, and the
 * reasoning for each.
 */

/**
 * OWASP's minimum Argon2id configuration: m=19456 KiB, t=2, p=1.
 *
 * Measured at ~12ms on the development machine, which is cheap enough to run on every login
 * and expensive enough that an offline attacker gains little per guess.
 */
/**
 * `Algorithm.Argon2id` is an ambient const enum, which this workspace cannot import under
 * `verbatimModuleSyntax` and which erases to nothing at runtime. The numeric value is used
 * instead, and a test asserts the produced digest actually carries the `$argon2id$` prefix —
 * so a silent change in the mapping fails loudly rather than downgrading the algorithm.
 */
const ARGON2ID_ALGORITHM = 2;

const ARGON2ID = {
  algorithm: ARGON2ID_ALGORITHM,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash a human-chosen secret — an owner password, or a one-time enrollment code. */
export async function hashHumanSecret(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2ID);
}

/**
 * Verify a human-chosen secret.
 *
 * Returns false rather than throwing on a malformed digest: a corrupt stored value is a
 * failed authentication, not a server error that would distinguish it from a wrong password.
 */
export async function verifyHumanSecret(digest: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(digest, plaintext, ARGON2ID);
  } catch {
    return false;
  }
}

/** 256 bits from the system CSPRNG, base64url so it survives a header or a URL unescaped. */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256, for looking up a high-entropy secret we generated ourselves.
 *
 * Deliberately not Argon2id. Argon2id exists to make *guessing* expensive, and guessing only
 * helps against a low-entropy human-chosen secret. A 256-bit random token has nothing to
 * guess: an attacker holding the stored value gains no offline advantage, while a per-request
 * Argon2id verification would add its cost to every authenticated call. It also keeps the
 * value indexable, which a salted digest is not.
 *
 * Used for session identifiers, which are looked up on every request.
 */
export function digestOfHighEntropySecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison for two values of the same expected length. */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak length. Compare a
  // fixed-size digest of each instead, so every comparison costs the same.
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * The wire form of an agent credential: `cdk_<environment>_<credentialId>_<secret>`.
 *
 * The credential id travels in the token so the row can be found by primary key. Without it
 * the server would have to try every stored digest, which is both slow and a timing signal.
 */
export interface AgentToken {
  readonly environment: string;
  readonly credentialId: string;
  readonly secret: string;
}

const TOKEN_PATTERN = /^cdk_([a-z-]+)_([A-Za-z0-9][A-Za-z0-9._-]{0,63})_([A-Za-z0-9_-]{43})$/;

export function formatAgentToken(token: AgentToken): string {
  return `cdk_${token.environment}_${token.credentialId}_${token.secret}`;
}

/** Parse, or return null. A malformed token is an authentication failure, never an error. */
export function parseAgentToken(raw: string): AgentToken | null {
  const match = TOKEN_PATTERN.exec(raw);
  if (match === null) return null;
  const [, environment, credentialId, secret] = match;
  // Every group is mandatory in the pattern, so this is unreachable; it is a refusal rather
  // than an assertion because a token parser must never throw on malformed input.
  if (environment === undefined || credentialId === undefined || secret === undefined) return null;
  return { environment, credentialId, secret };
}
