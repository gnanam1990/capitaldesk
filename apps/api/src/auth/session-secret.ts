import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the OWNER_SESSION credential from its reference.
 *
 * Configuration carries a *reference* — a path or secret-manager URI — never the secret
 * itself (ADR-0007). Signing cookies with the reference string would be a serious defect
 * rather than a shortcut: every deployment configured with the same conventional path, such
 * as `file:///run/secrets/owner-session`, would share a key an attacker can simply guess, and
 * the mounted secret would never be read at all.
 *
 * The resolver is deliberately narrow. Only `file:` is supported, because that is the only
 * mount this release documents; an unsupported scheme is refused rather than silently treated
 * as a literal value, which is exactly how a reference becomes a key.
 */

export class SessionSecretError extends Error {
  constructor(message: string) {
    // The message names the reference and the problem, never any resolved content.
    super(`owner session secret: ${message}`);
    this.name = 'SessionSecretError';
  }
}

/**
 * Minimum accepted length.
 *
 * @fastify/cookie requires at least 32 characters for its own signing, and a short or
 * placeholder file is the realistic failure — an empty mount, a truncated write, a file
 * containing the word "changeme" — not an attacker-chosen one.
 */
const MINIMUM_SECRET_LENGTH = 32;

/** Values that are syntactically fine and obviously not a secret. */
const REFUSED_PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'secret',
  'password',
  'placeholder',
  'todo',
]);

export function resolveOwnerSessionSecret(reference: string): string {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new SessionSecretError(
      `reference is not a URI. Use a file reference such as file:///run/secrets/owner-session`,
    );
  }

  if (url.protocol !== 'file:') {
    throw new SessionSecretError(
      `unsupported scheme "${url.protocol}". Only file: references are supported in this release`,
    );
  }

  let contents: string;
  try {
    contents = readFileSync(fileURLToPath(url), 'utf8');
  } catch (error) {
    throw new SessionSecretError(
      `cannot read the referenced file (${error instanceof Error ? error.name : 'unknown error'})`,
    );
  }

  // Trailing newlines are what a here-doc or an editor adds, not part of the secret.
  const secret = contents.trim();

  if (secret.length === 0) {
    throw new SessionSecretError('the referenced file is empty');
  }
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new SessionSecretError(
      `the referenced file holds ${String(secret.length)} characters; at least ${String(MINIMUM_SECRET_LENGTH)} are required`,
    );
  }
  if (REFUSED_PLACEHOLDERS.has(secret.toLowerCase())) {
    throw new SessionSecretError('the referenced file holds a placeholder rather than a secret');
  }
  if (new Set(secret).size < 8) {
    // "aaaa..." satisfies a length check and has almost no entropy.
    throw new SessionSecretError('the referenced file holds too few distinct characters');
  }

  return secret;
}
