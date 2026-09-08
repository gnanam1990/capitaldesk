/**
 * Same-origin routing for the owner console.
 *
 * The owner session cookie is `SameSite=Strict`, which is the point of it: a strict cookie is
 * not attached to a request the browser considers cross-site, so a page on another origin
 * cannot make an authenticated call at all. That protection has a cost — the console must be
 * the same origin as the API, or its own fetches lose the cookie too.
 *
 * In development the console runs on one port and the API on another, which are different
 * origins. The tempting fixes are all worse: relaxing the cookie to `SameSite=Lax`, or adding
 * a CORS exception with credentials, would weaken a production control to accommodate a
 * development layout. Instead the console proxies `/api/*` to the API, so the browser only
 * ever sees one origin and the strict cookie behaves in development exactly as it does in
 * production.
 *
 * Browser code must therefore call `/api/...` — a relative path — and never the configured
 * API base URL, which is a server-side address.
 */

export const API_PREFIX = '/api';

export interface ApiRewrite {
  readonly source: string;
  readonly destination: string;
}

export class ApiRoutingError extends Error {}

/**
 * Normalise the API origin the console proxies to.
 *
 * A trailing slash produced `//v1/...` once already in the health URL; refusing it here keeps
 * the destination template exact. Only http and https are accepted: a `file:` or `data:` base
 * would be a misconfiguration that Next would otherwise carry into a running proxy.
 */
export function apiRewrites(apiBaseUrl: string): readonly ApiRewrite[] {
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new ApiRoutingError('the API base URL is not a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiRoutingError(`the API base URL must be http or https, not ${parsed.protocol}`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new ApiRoutingError('the API base URL must not carry a query or fragment');
  }

  const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  return [{ source: `${API_PREFIX}/:path*`, destination: `${base}/:path*` }];
}
