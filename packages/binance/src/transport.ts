import { createHash } from 'node:crypto';
import {
  assertApprovedVenueOrigin,
  violate,
  type DeploymentEnvironment,
} from '@capitaldesk/contracts';
import {
  READ_ENDPOINTS,
  buildReadUrl,
  isNamedRead,
  requestWeight,
  type ReadEndpoint,
  type ReadEndpointName,
  type ReadOrigin,
} from './endpoints.js';
import {
  parseRetryAfter,
  rateLimited,
  schemaUnrecognized,
  unavailable,
  venueRejected,
} from './failures.js';
import { decodeVenueError } from './decode.js';
import { redactText, redactUrl, safeHeaders } from './redaction.js';

/**
 * The read-only transport: the write barrier and the credential barrier in one place.
 *
 * There is exactly one verb, `read`, and it takes an endpoint *name* from the verified table
 * plus parameters. There is no URL parameter, no method parameter and no generic request,
 * which is the acceptance gate prompt 05 states: write methods cannot be reached through a
 * generic passthrough. Adding one would not be a new feature here, it would be the removal of
 * the guarantee.
 *
 * The credential is opaque. This class never sees a key or a secret; it hands the query to the
 * credential and receives headers and a signed query back. What it does check is the class: a
 * `VENUE_TRADE` credential cannot construct a reader at all (ADR-0007).
 */

/**
 * A VENUE_READ credential, as the transport sees it.
 *
 * Deliberately not a key and a secret. The credential decorates a request and never yields its
 * material, so no code path here can log it, digest it or send it anywhere but into the
 * request it authorised.
 */
export interface ReadCredential {
  readonly credentialClass: 'VENUE_READ';
  /** Non-secret operator label, safe to log. */
  readonly alias: string;
  authorize(query: URLSearchParams): {
    readonly headers: Readonly<Record<string, string>>;
    readonly signedQuery: URLSearchParams;
  };
}

/** One completed read, with the provenance every observation must carry. */
export interface ReadResult {
  readonly endpoint: ReadEndpointName;
  readonly status: number;
  readonly body: string;
  /** sha256 of the exact response bytes, so a reader can recompute it independently. */
  readonly bodyDigest: string;
  /** The request interval: both ends, from the injected clock. */
  readonly requestedAt: Date;
  readonly respondedAt: Date;
  /** The request URL with credential material removed. */
  readonly requestUrl: string;
  /** Allowlisted response headers only. */
  readonly headers: Readonly<Record<string, string>>;
  /** The documented weight this call actually cost. */
  readonly weight: number;
}

export interface TransportOptions {
  /**
   * The deployment this reader runs in. Its approved origins are the only ones reachable.
   *
   * Required, and not inferable from the origin: the whole point is that the origin is
   * checked against something the operator configured, rather than trusted because a caller
   * produced it.
   */
  readonly deployment: DeploymentEnvironment;
  readonly origin: ReadOrigin;
  readonly fetch: typeof fetch;
  /** Null is permitted: public market reads need no credential. */
  readonly credential: ReadCredential | null;
  readonly now: () => Date;
}

export class ReadOnlyTransport {
  readonly #origin: ReadOrigin;
  readonly #fetch: typeof fetch;
  readonly #credential: ReadCredential | null;
  readonly #now: () => Date;

  constructor(options: TransportOptions) {
    // A trade credential must not be able to construct a reader, and the refusal happens
    // before any request exists rather than at send time.
    if (options.credential !== null && options.credential.credentialClass !== 'VENUE_READ') {
      violate('AUTHZ_CREDENTIAL_CLASS_DENIED', 'the account reader accepts only VENUE_READ', {
        credentialClass: String(
          (options.credential as { credentialClass?: string }).credentialClass,
        ),
      });
    }
    // The origin must be one the operator's deployment approves, not merely a well-formed
    // one. An earlier version refused only plain http on a non-loopback host, so
    // `https://attacker.invalid` constructed a working reader that would send the API key
    // header and the signed query string to it. The check is a runtime membership test
    // against the shared allowlist, at construction, before any request exists — not a type
    // brand and not caller discipline.
    assertApprovedVenueOrigin(options.deployment, options.origin.origin);
    this.#origin = options.origin;
    this.#fetch = options.fetch;
    this.#credential = options.credential;
    this.#now = options.now;
  }

  /**
   * Perform one named read.
   *
   * Parameters are validated against the venue's own documented bounds *before* the request is
   * sent: a window wider than 24 hours or a page above 1000 is a request the venue will reject
   * anyway, and spending weight to learn that is how a client walks into a rate limit.
   */
  async read(
    name: ReadEndpointName,
    parameters: Readonly<Record<string, string>>,
  ): Promise<ReadResult> {
    const endpoint = READ_ENDPOINTS[name];
    assertWithinDocumentedBounds(name, parameters);

    // One validated instant, used as both the signed timestamp and the start of the interval
    // this result promises. Reading the clock twice would let the value that was signed differ
    // from the value recorded, and validating only the authenticated path would let a public
    // read return an Invalid Date as its provenance.
    const requestedAt = instantFrom(this.#now(), name, 'the request start');

    const query = new URLSearchParams(parameters);
    let headers: Readonly<Record<string, string>> = {};
    if (endpoint.security === 'USER_DATA') {
      if (this.#credential === null) {
        violate(
          'AUTHZ_CREDENTIAL_CLASS_DENIED',
          'an authenticated read needs a VENUE_READ credential',
          { endpoint: name },
        );
      }
      // The venue's own mandatory parameter, from that same instant.
      query.set('timestamp', String(requestedAt.getTime()));
      const authorized = this.#credential.authorize(query);
      headers = authorized.headers;
      for (const [key, value] of authorized.signedQuery) query.set(key, value);
    }

    const url = buildReadUrl(this.#origin, name, Object.fromEntries(query));
    // The last line, immediately before the send: this exact method, origin and path are the
    // read that was named. Nothing between here and fetch can change it.
    if (!isNamedRead(this.#origin, name, 'GET', url)) {
      violate('IDENTITY_MALFORMED', 'the constructed request is not the named read', {
        endpoint: name,
      });
    }

    // `redirect: 'error'` is the point: a 3xx to a hostile host would otherwise replay the
    // signed query string there, and the API key header with it.
    const request = new Request(url, { method: 'GET', headers, redirect: 'error' });

    let response: Response;
    try {
      response = await this.#fetch(request);
    } catch (error) {
      throw unavailable(name, redactText(error instanceof Error ? error.message : 'unknown', []));
    }
    if (response.status >= 300 && response.status < 400) {
      // Never followed. Where it points is not this reader's business, and its body is not
      // worth reading.
      throw unavailable(
        name,
        `the venue answered with a redirect (${String(response.status)})`,
        response.status,
      );
    }

    // The body is read before the interval closes. Stamping `respondedAt` at the headers and
    // then awaiting the body reports an interval that excludes however long the body took —
    // which is the part that actually varies — while the provenance claims to describe the
    // whole request.
    let body: string;
    let bodyDigest: string;
    try {
      // The exact bytes are hashed, then decoded separately. `response.text()` applies UTF-8
      // decoding first, which silently strips a byte-order mark and replaces invalid sequences
      // with U+FFFD — so a digest taken over the decoded string is a digest of something the
      // venue did not send, and an independent verifier recomputing it from the wire would get
      // a different value.
      const bytes = Buffer.from(await response.arrayBuffer());
      bodyDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      body = new TextDecoder().decode(bytes);
    } catch (error) {
      // A body that could not be read is an unknown fact, not an empty one. Returning '' made
      // a truncated response decode as "no trades" or "no open orders", which is the shape of
      // answer that releases capital.
      throw unavailable(
        name,
        `the response body could not be read: ${redactText(
          error instanceof Error ? error.message : 'unknown',
          [],
        )}`,
        response.status,
      );
    }

    const respondedAt = instantFrom(this.#now(), name, 'the response instant');
    // A result promises an ordered interval. A clock that moved backwards during the request
    // produces a negative duration, and a negative duration in an evidence record is worse
    // than no record: it looks like a measurement rather than a fault.
    if (respondedAt.getTime() < requestedAt.getTime()) {
      violate('CLOCK_SKEW_UNBOUNDED', 'the clock moved backwards during the request', {
        endpoint: name,
      });
    }

    const result: ReadResult = {
      endpoint: name,
      status: response.status,
      body,
      bodyDigest,
      requestedAt,
      respondedAt,
      requestUrl: redactUrl(url),
      headers: safeHeaders(response.headers),
      weight: requestWeight(name, parameters),
    };

    if (response.status === 429 || response.status === 418) {
      throw rateLimited(
        name,
        response.status,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    if (response.status >= 500) {
      throw unavailable(name, `the venue answered ${String(response.status)}`, response.status);
    }
    if (response.status >= 400) {
      const venueError = decodeVenueError(body);
      if (venueError === null) {
        // A 4xx we cannot read is not a rejection we can reason about.
        throw schemaUnrecognized(name, `HTTP ${String(response.status)} with an unreadable body`);
      }
      throw venueRejected(name, venueError.code, venueError.msg, response.status);
    }
    return result;
  }
}

/**
 * The venue's own documented limits, enforced before a request is spent.
 *
 * These are transcribed in the endpoint table from the official document. Sending a request
 * the venue will reject costs its full weight and returns nothing.
 */
function assertWithinDocumentedBounds(
  name: ReadEndpointName,
  parameters: Readonly<Record<string, string>>,
): void {
  const endpoint: ReadEndpoint = READ_ENDPOINTS[name];
  for (const required of endpoint.mandatory) {
    // `timestamp` is stamped by the transport itself for signed reads.
    if (required === 'timestamp') continue;
    const value = parameters[required];
    if (value === undefined || value.trim() === '') {
      violate('IDENTITY_MALFORMED', `${name} requires ${required}`, { endpoint: name });
    }
  }
  // Numeric parameters are validated as bounded non-negative integers before anything is
  // compared. `Number()` accepts '', ' ', '1.5', '1e3' and 'Infinity', so a comparison built
  // on it lets a fractional limit or a non-finite window through to be rejected by the venue
  // at the cost of the request's full weight — or, worse, accepted.
  const limit = boundedInteger(name, parameters, 'limit');
  const maxLimit = endpoint.maxLimit;
  if (maxLimit !== undefined && limit !== null && limit > maxLimit) {
    violate('IDENTITY_MALFORMED', `${name} allows at most ${String(maxLimit)} rows per page`, {
      endpoint: name,
      limit: String(limit),
    });
  }
  if (limit !== null && limit <= 0) {
    violate('IDENTITY_MALFORMED', `${name} needs a positive page size`, { endpoint: name });
  }

  const startTime = boundedInteger(name, parameters, 'startTime');
  const endTime = boundedInteger(name, parameters, 'endTime');
  const maxRangeMs = endpoint.maxRangeMs;
  if (maxRangeMs !== undefined && startTime !== null && endTime !== null) {
    const span = endTime - startTime;
    if (span < 0 || span > maxRangeMs) {
      violate('IDENTITY_MALFORMED', `${name} allows a window of at most ${String(maxRangeMs)} ms`, {
        endpoint: name,
        startTime: String(startTime),
        endTime: String(endTime),
      });
    }
  }
  // `fromId` and `orderId` are venue identities, not arithmetic. They are validated as
  // canonical digit strings and never passed through Number: an id past
  // Number.MAX_SAFE_INTEGER is a legitimate venue identity that Number would silently round,
  // and rounding a cursor changes which page of an account's trade history is fetched.
  digitString(name, parameters, 'fromId');
  digitString(name, parameters, 'orderId');

  // "Either orderId or origClientOrderId must be sent." A query with neither is not a lookup
  // of a specific order; the venue rejects it, and spending the weight to learn that is the
  // mistake this check exists to avoid.
  if (name === 'order') {
    const byVenueId = parameters['orderId'];
    const byClientId = parameters['origClientOrderId'];
    if (
      (byVenueId === undefined || byVenueId.trim() === '') &&
      (byClientId === undefined || byClientId.trim() === '')
    ) {
      violate('IDENTITY_MALFORMED', 'order lookup needs orderId or origClientOrderId', {
        endpoint: name,
      });
    }
    // Both together is documented and legal: "the orderId is searched first, then the
    // origClientOrderId from that result is checked against that order." That is the venue's
    // own cross-check and is stricter than either alone, so it is permitted rather than
    // refused.
  }
}

/** A Date that is actually an instant, or a typed refusal. */
function instantFrom(value: Date, endpoint: ReadEndpointName, what: string): Date {
  const epoch = value.getTime();
  if (!Number.isFinite(epoch) || !Number.isSafeInteger(epoch)) {
    violate('CLOCK_SKEW_UNBOUNDED', `the clock did not yield ${what}`, { endpoint });
  }
  return value;
}

/**
 * A venue identity or cursor: canonical digits, validated as text.
 *
 * No `Number` anywhere. These values routinely exceed `Number.MAX_SAFE_INTEGER`, which is why
 * the decoders keep them as strings, and a bound that coerced them would round a legitimate id
 * into a different one. Leading zeros are refused as well: `007` and `7` are the same number
 * and two different strings, and a cursor compared as text must have one spelling.
 */
function digitString(
  endpoint: ReadEndpointName,
  parameters: Readonly<Record<string, string>>,
  field: string,
): void {
  const raw = parameters[field];
  if (raw === undefined) return;
  const text = raw.trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    violate('IDENTITY_MALFORMED', `${endpoint} ${field} must be a canonical venue identity`, {
      endpoint,
      field,
      value: text,
    });
  }
}

/**
 * A parameter this code does arithmetic on: a page size, or a millisecond instant.
 *
 * Only these go through a safe-number bound, because only these are compared or subtracted
 * here. Venue identities and cursors do not — see {@link digitString}.
 */
function boundedInteger(
  endpoint: ReadEndpointName,
  parameters: Readonly<Record<string, string>>,
  field: string,
): number | null {
  const raw = parameters[field];
  if (raw === undefined) return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    violate('IDENTITY_MALFORMED', `${endpoint} ${field} must be a non-negative integer`, {
      endpoint,
      field,
      value: text,
    });
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    violate('IDENTITY_MALFORMED', `${endpoint} ${field} is beyond a safe integer`, {
      endpoint,
      field,
    });
  }
  return value;
}
