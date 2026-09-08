/**
 * Keeping credential material out of everything this package emits (T-044).
 *
 * A signed Binance read request carries the API key in the `X-MBX-APIKEY` header and the
 * HMAC in the query string. Errors, logs and evidence digests are all built from the URL and
 * the headers, so both are secret-bearing by construction and neither may be recorded raw.
 *
 * Both directions are covered: known secret values are removed by value, and anything shaped
 * like a credential parameter is removed by name even when this module was never told the
 * value. The second half matters because the first depends on a caller remembering to pass
 * the secret in.
 */

/** Query parameters that carry credential material, matched case-insensitively. */
const CREDENTIAL_PARAMETERS: ReadonlySet<string> = new Set([
  'signature',
  'apikey',
  'api_key',
  'secret',
  'secretkey',
  'secret_key',
  'token',
  'access_token',
  'x-mbx-apikey',
]);

/**
 * Response headers worth keeping in a diagnostic.
 *
 * An allowlist, not a denylist: a denylist leaks whatever header the venue invents next.
 */
const SAFE_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'retry-after',
  'x-mbx-used-weight',
  'x-mbx-used-weight-1m',
  'x-mbx-order-count-1s',
  'x-mbx-order-count-1d',
  'x-mbx-uuid',
]);

export const REDACTED = 'REDACTED';

/**
 * A URL safe to record: userinfo dropped, credential parameters replaced by name.
 *
 * The host and path survive deliberately. A redaction that removed them would protect the key
 * and destroy the ability to reproduce the incident, which is the trade TDD section 13 asks
 * us not to make.
 */
export function redactUrl(url: URL): string {
  const safe = new URL(url.toString());
  safe.username = '';
  safe.password = '';
  for (const name of [...safe.searchParams.keys()]) {
    if (CREDENTIAL_PARAMETERS.has(name.toLowerCase())) safe.searchParams.set(name, REDACTED);
  }
  return safe.toString();
}

/** The subset of response headers that may be logged or attached to an error. */
export function safeHeaders(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (SAFE_HEADERS.has(lower)) kept[lower] = value;
  });
  return kept;
}

/** Anything shaped like `signature=...` or `apiKey=...` inside free text. */
const CREDENTIAL_IN_TEXT = new RegExp(
  `\\b(${[...CREDENTIAL_PARAMETERS].join('|')})=[^&\\s"']+`,
  'gi',
);

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Free text with known secrets and credential-shaped parameters removed.
 *
 * An empty or whitespace-only "secret" is ignored. Replacing every empty match would turn any
 * message into a wall of REDACTED, which loses the diagnostic without protecting anything.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim() === '') continue;
    out = out.replaceAll(new RegExp(escapeForRegExp(secret), 'g'), REDACTED);
  }
  return out.replace(CREDENTIAL_IN_TEXT, (match) => `${match.split('=')[0] ?? ''}=${REDACTED}`);
}
