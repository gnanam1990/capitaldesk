/**
 * Redaction.
 *
 * Credentials, signatures and session material must never reach a log, an export, a
 * screenshot or a support bundle (PRD non-functional security, TEST-PLAN T-044). Redaction
 * is applied by key name and by value shape, because a secret often arrives under a key we
 * did not anticipate — for example inside a URL query string or an error message.
 */

export const REDACTED = '[redacted]';

/** Key names whose values are always removed, matched case-insensitively as substrings. */
const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'secret',
  'password',
  'passphrase',
  'token',
  'authorization',
  'cookie',
  'signature',
  'x-mbx-apikey',
  'privatekey',
  'private_key',
  'credential',
  'session',
];

/**
 * Query parameter names whose values are redacted inside any URL-shaped string.
 *
 * Matched as a *fragment* of the parameter name, so aliases are covered without enumerating
 * every spelling: `access_token`, `refreshToken`, `client_secret`, `api-key` and
 * `X-Api-Key` all contain one of these fragments. An earlier version listed exact names and
 * leaked every alias that was not on the list.
 */
const SENSITIVE_QUERY_FRAGMENTS = [
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'password',
  'passwd',
  'credential',
  'signature',
  'sig',
  'auth',
  'session',
  'key',
];

/** Value shapes that are redacted regardless of the key they arrived under. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // Binance API keys and secrets are 64-character alphanumerics.
  /\b[A-Za-z0-9]{64}\b/g,
  // Bearer/Basic authorization payloads.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** Query parameters whose *name* contains a sensitive fragment, in any URL-shaped string. */
const QUERY_PARAMETER_PATTERN = /([?&])([A-Za-z0-9._~%-]+)(=)([^&\s"']*)/g;

function isSensitiveParameterName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_QUERY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

export function redactText(text: string): string {
  let output = text.replace(
    QUERY_PARAMETER_PATTERN,
    (match, separator: string, name: string, equals: string, value: string) =>
      isSensitiveParameterName(name) && value.length > 0
        ? `${separator}${name}${equals}${REDACTED}`
        : match,
  );
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    output = output.replace(pattern, () => REDACTED);
  }
  return output;
}

/**
 * Deep redaction with a bounded depth. Unknown object shapes are traversed; anything that
 * cannot be traversed safely is replaced rather than serialized as-is.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth-limited]';
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return redactText(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return `[${typeof value}]`;
    case 'undefined':
    case 'object':
      // Handled below: objects are traversed, and `undefined` returned earlier.
      break;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack === undefined ? undefined : redactText(value.stack),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  if (value instanceof Map || value instanceof Set) {
    return `[${value.constructor.name}]`;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return output;
}
