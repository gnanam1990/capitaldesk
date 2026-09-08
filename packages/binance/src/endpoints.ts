/**
 * The Binance Spot read endpoints this product is permitted to call, bound to one origin.
 *
 * Every entry is transcribed from the official Spot REST document at the revision recorded in
 * `docs/evidence/binance-read-capability.md`, and the response shapes were confirmed against
 * a real public read of `testnet.binance.vision`. Nothing here is recalled or inferred: a
 * weight guessed from memory is how a client walks into an IP ban, and prompt 05 forbids
 * guessing endpoint fields or flags.
 *
 * ## Why the origin is part of the endpoint
 *
 * An earlier version of this module exposed `isReadableUrl(method, url)`, which checked the
 * method and the normalised pathname and nothing else. `https://attacker.invalid/api/v3/account`
 * passed it. That is not a theoretical weakness: a USER_DATA read carries the API key in a
 * header and an HMAC in the query string, so a request built for a hostile origin hands both
 * to whoever answers.
 *
 * So a caller cannot supply a URL at all. It names an endpoint and passes parameters, and
 * {@link buildReadUrl} constructs the URL against a {@link ReadOrigin} that was validated
 * once, at construction, against the environment's approved host. {@link isReadableUrl} exists
 * for the transport's own last-line assertion and takes that same origin, comparing scheme,
 * hostname and port together with the method and the exact path of the *named* endpoint.
 */

import { violate } from '@capitaldesk/contracts';

/** What credential class an endpoint requires. `NONE` is a public market endpoint. */
export type EndpointSecurity = 'NONE' | 'USER_DATA';

export interface ReadEndpoint {
  /** Always GET. A read boundary that can express another method is not a read boundary. */
  readonly method: 'GET';
  readonly path: string;
  readonly security: EndpointSecurity;
  /** Documented request weight when no conditional rule applies. */
  readonly weight: number;
  /** Parameters the venue documents as mandatory. */
  readonly mandatory: readonly string[];
  /** The venue's documented maximum span between startTime and endTime, where it states one. */
  readonly maxRangeMs?: number;
  /** The venue's documented maximum page size, where it states one. */
  readonly maxLimit?: number;
  /** Where this entry's numbers come from, for the evidence record. */
  readonly source: string;
}

const SPOT_REST = 'binance-spot-api-docs/rest-api.md';

export const READ_ENDPOINTS = {
  serverTime: {
    method: 'GET',
    path: '/api/v3/time',
    security: 'NONE',
    weight: 1,
    mandatory: [],
    source: `${SPOT_REST} — Check server time`,
  },
  exchangeInfo: {
    method: 'GET',
    path: '/api/v3/exchangeInfo',
    security: 'NONE',
    weight: 20,
    mandatory: [],
    source: `${SPOT_REST} — Exchange information, weight 20`,
  },
  account: {
    method: 'GET',
    path: '/api/v3/account',
    security: 'USER_DATA',
    weight: 20,
    mandatory: ['timestamp'],
    source: `${SPOT_REST} — Account information (USER_DATA), weight 20`,
  },
  order: {
    method: 'GET',
    path: '/api/v3/order',
    security: 'USER_DATA',
    weight: 4,
    mandatory: ['symbol', 'timestamp'],
    source: `${SPOT_REST} — Query order (USER_DATA), weight 4`,
  },
  openOrders: {
    method: 'GET',
    path: '/api/v3/openOrders',
    security: 'USER_DATA',
    // 6 for a single symbol; 80 when the symbol parameter is omitted. The account-wide scan
    // ADR-0002 condition C2 requires is the expensive one, and the caller must know that.
    weight: 80,
    mandatory: ['timestamp'],
    source: `${SPOT_REST} — Current open orders (USER_DATA), weight 6 with symbol, 80 without`,
  },
  myTrades: {
    method: 'GET',
    path: '/api/v3/myTrades',
    security: 'USER_DATA',
    // 20 without orderId, 5 with.
    weight: 20,
    mandatory: ['symbol', 'timestamp'],
    // "The time between startTime and endTime can't be longer than 24 hours."
    maxRangeMs: 24 * 60 * 60 * 1000,
    // "Default: 500; Maximum: 1000."
    maxLimit: 1000,
    source: `${SPOT_REST} — Account trade list (USER_DATA), weight 20 without orderId, 5 with`,
  },
} as const satisfies Record<string, ReadEndpoint>;

export type ReadEndpointName = keyof typeof READ_ENDPOINTS;

/**
 * A parameter value that is actually present.
 *
 * `symbol=''` is not a symbol and `orderId=null` is not an order id. Treating either as
 * present would hand the caller the cheaper conditional weight for a request that the venue
 * charges at the expensive rate — 6 instead of 80 for an account-wide open-order scan — and
 * the difference is discovered as a 429 followed by an IP ban.
 */
function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'bigint') return true;
  return false;
}

/** The weight this call will actually cost, including the venue's conditional rules. */
export function requestWeight(
  name: ReadEndpointName,
  parameters: Readonly<Record<string, unknown>>,
): number {
  switch (name) {
    case 'openOrders':
      return present(parameters['symbol']) ? 6 : 80;
    case 'myTrades':
      return present(parameters['orderId']) ? 5 : 20;
    case 'serverTime':
    case 'exchangeInfo':
    case 'account':
    case 'order':
      return READ_ENDPOINTS[name].weight;
  }
}

/**
 * The one origin this reader may ever contact, validated once.
 *
 * Constructed from the environment's approved host, which `@capitaldesk/config` allowlists per
 * deployment. This type carries no credential and no transport; it is the proof that a URL
 * built later points where the operator said it should.
 */
export interface ReadOrigin {
  /** `scheme://host[:port]`, exactly as the URL parser normalises it. */
  readonly origin: string;
  readonly protocol: 'https:' | 'http:';
  readonly hostname: string;
  /** The effective port, with the scheme default made explicit. */
  readonly port: string;
}

/** Loopback names, the only hosts permitted to be reached over plain http. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

function defaultPortFor(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

/**
 * Validate a configured base URL into a {@link ReadOrigin}.
 *
 * Refuses anything that is not purely an origin: userinfo, a path, a query, a fragment, a
 * scheme other than http/https, and plain http anywhere but a loopback address. The caller's
 * environment allowlist decides *which* origin is approved; this decides that the string is an
 * origin at all and carries nothing extra to be smuggled into a signed request.
 */
export function readOrigin(baseUrl: string): ReadOrigin {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    violate('IDENTITY_MALFORMED', 'venue base URL is not a URL', { baseUrl });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    violate('IDENTITY_MALFORMED', 'venue base URL must be http or https', {
      protocol: url.protocol,
    });
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    violate('IDENTITY_MALFORMED', 'a signed read may not be sent over plain http', {
      hostname: url.hostname,
    });
  }
  if (url.username !== '' || url.password !== '') {
    violate('IDENTITY_MALFORMED', 'venue base URL must not carry userinfo', {
      hostname: url.hostname,
    });
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    violate('IDENTITY_MALFORMED', 'venue base URL must be an origin with no path, query or hash', {
      baseUrl: `${url.protocol}//${url.host}${url.pathname}`,
    });
  }
  return {
    origin: url.origin,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === '' ? defaultPortFor(url.protocol) : url.port,
  };
}

/**
 * The URL for one named endpoint against one validated origin.
 *
 * This is the only way to obtain a request URL. The path comes from the table, never from the
 * caller, so there is no string to traverse out of and no way to name an endpoint that is not
 * in the table. Parameter values are appended through `URLSearchParams`, which encodes them.
 */
export function buildReadUrl(
  origin: ReadOrigin,
  name: ReadEndpointName,
  parameters: Readonly<Record<string, string>> = {},
): URL {
  const url = new URL(READ_ENDPOINTS[name].path, origin.origin);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.append(key, value);
  return url;
}

/**
 * Whether this exact request is the named read against the approved origin.
 *
 * The transport's last-line assertion, and deliberately not a general-purpose URL filter:
 * every component that could redirect a signed request elsewhere is compared, and the path is
 * compared against the endpoint the caller *named* rather than against the whole table. A
 * traversal that resolves onto some other tabled read is therefore refused too — it is no
 * longer the request that was authorised.
 */
export function isReadableUrl(origin: ReadOrigin, method: string, url: URL): boolean {
  return (Object.keys(READ_ENDPOINTS) as ReadEndpointName[]).some((name) =>
    isNamedRead(origin, name, method, url),
  );
}

/** Whether this request is exactly the named endpoint against the approved origin. */
export function isNamedRead(
  origin: ReadOrigin,
  name: ReadEndpointName,
  method: string,
  url: URL,
): boolean {
  const endpoint = READ_ENDPOINTS[name];
  return (
    // Exact, case-sensitive. Accepting 'get' establishes the reasoning by which 'Post' is
    // also acceptable.
    method === endpoint.method &&
    // `URL#origin` folds scheme, hostname and port together and excludes userinfo, so a
    // lookalike host, a subdomain, an alternate scheme or a non-default port all fail here.
    url.origin === origin.origin &&
    url.protocol === origin.protocol &&
    url.hostname === origin.hostname &&
    (url.port === '' ? defaultPortFor(url.protocol) : url.port) === origin.port &&
    // `URL#origin` ignores userinfo and the fragment, so both are refused explicitly: a
    // credential in the userinfo would still be transmitted, and a fragment is never part of
    // a request we build.
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    // Already normalised by the parser, so a traversal is judged by where it resolves.
    url.pathname === endpoint.path
  );
}
