import { describe, expect, it, vi } from 'vitest';
import { ContractViolation } from '@capitaldesk/contracts';
import { ReadFailure } from './failures.js';
import { readOrigin } from './endpoints.js';
import { ReadOnlyTransport, type ReadCredential } from './transport.js';

/**
 * The transport is the write barrier and the credential barrier in one place.
 *
 * It exposes no generic request method, no URL parameter and no method parameter. A caller
 * names a tabled endpoint and supplies parameters; everything else is decided here. The tests
 * below include the structural ones prompt 05 asks for: no API key or signature can reach any
 * origin but the one the deployment approves, and a TRADE credential cannot be used at all.
 */
const TESTNET = readOrigin('https://testnet.binance.vision');

/** A VENUE_READ credential double. It never yields its secret, only a decorated request. */
function readCredential(alias = 'venue-read-fixture'): ReadCredential {
  return {
    credentialClass: 'VENUE_READ',
    alias,
    authorize(query) {
      const signed = new URLSearchParams(query);
      signed.set('signature', 'FIXTURE-SIGNATURE-VALUE');
      return { headers: { 'X-MBX-APIKEY': 'FIXTURE-API-KEY-VALUE' }, signedQuery: signed };
    },
  };
}

/**
 * A response from the double, already resolved.
 *
 * Headers are merged rather than replaced: spreading `init` over a default `headers` key drops
 * the content type whenever a case sets any header, which made one assertion describe the
 * double's default instead of the venue's answer.
 */
function respond(body: unknown, init: ResponseInit = {}): Promise<Response> {
  return Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    }),
  );
}

/** A double that records what it was asked to send and answers with `response`. */
function recording(response: () => Promise<Response> = () => respond({ serverTime: 1 })): {
  fetchImpl: typeof fetch;
  seen: Request[];
} {
  const seen: Request[] = [];
  const fetchImpl = vi.fn((input: Request) => {
    seen.push(input);
    return response();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** A double that fails the test if it is ever called. */
function neverCalled(): typeof fetch {
  return vi.fn((): Promise<Response> => {
    throw new Error('the transport must not have sent anything');
  });
}

function transportWith(
  fetchImpl: typeof fetch,
  credential: ReadCredential | null = readCredential(),
): ReadOnlyTransport {
  return new ReadOnlyTransport({
    deployment: 'testnet',
    origin: TESTNET,
    fetch: fetchImpl,
    credential,
    now: () => new Date('2026-09-08T12:00:00.000Z'),
  });
}

describe('the read-only transport', () => {
  it('has no generic request, url, method or passthrough member', () => {
    // The acceptance gate: write methods cannot be reached through a generic passthrough.
    const surface = new Set([
      ...Object.getOwnPropertyNames(ReadOnlyTransport.prototype),
      ...Object.getOwnPropertyNames(transportWith(neverCalled())),
    ]);
    for (const forbidden of [
      'request',
      'send',
      'post',
      'put',
      'delete',
      'patch',
      'fetch',
      'call',
      'execute',
      'raw',
      'passthrough',
      'signedRequest',
    ]) {
      expect(surface.has(forbidden), forbidden).toBe(false);
    }
    // What it does expose is exactly one verb.
    expect([...surface].filter((name) => name !== 'constructor')).toEqual(['read']);
  });

  it('sends a public read with no credential material at all', async () => {
    const { fetchImpl, seen } = recording();
    await transportWith(fetchImpl).read('serverTime', {});

    const request = seen[0];
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe('https://testnet.binance.vision/api/v3/time');
    expect(request?.headers.get('X-MBX-APIKEY')).toBeNull();
    expect(new URL(request?.url ?? '').searchParams.get('signature')).toBeNull();
  });

  it('signs an authenticated read and stamps the venue timestamp', async () => {
    const { fetchImpl, seen } = recording(() => respond([]));
    await transportWith(fetchImpl).read('openOrders', {});

    const url = new URL(seen[0]?.url ?? '');
    expect(url.searchParams.get('signature')).toBe('FIXTURE-SIGNATURE-VALUE');
    expect(url.searchParams.get('timestamp')).toBe(String(Date.parse('2026-09-08T12:00:00.000Z')));
    expect(seen[0]?.headers.get('X-MBX-APIKEY')).toBe('FIXTURE-API-KEY-VALUE');
  });

  describe('the credential class barrier', () => {
    it('refuses to use anything that is not a VENUE_READ credential', () => {
      for (const credentialClass of ['VENUE_TRADE', 'OWNER_SESSION', 'AGENT_PROPOSAL']) {
        const wrong = { ...readCredential(), credentialClass } as unknown as ReadCredential;
        expect(() => transportWith(neverCalled(), wrong), credentialClass).toThrow(
          ContractViolation,
        );
      }
    });

    it('names AUTHZ_CREDENTIAL_CLASS_DENIED, so the refusal is the documented one', () => {
      const trade = {
        ...readCredential(),
        credentialClass: 'VENUE_TRADE',
      } as unknown as ReadCredential;
      try {
        transportWith(neverCalled(), trade);
        expect.unreachable('a trade credential must not construct a reader');
      } catch (error) {
        expect((error as ContractViolation).reason).toBe('AUTHZ_CREDENTIAL_CLASS_DENIED');
      }
    });

    it('refuses an authenticated read with no credential, rather than sending it unsigned', async () => {
      const fetchImpl = neverCalled();
      const failure = await transportWith(fetchImpl, null)
        .read('account', {})
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ContractViolation);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('still performs a public read with no credential configured', async () => {
      const { fetchImpl } = recording();
      const result = await transportWith(fetchImpl, null).read('serverTime', {});
      expect(result.status).toBe(200);
    });
  });

  /**
   * No signed request reaches an origin the deployment did not approve.
   *
   * An earlier version refused only plain http on a non-loopback host, so the negative test
   * used `http://attacker.invalid` and proved the scheme rule rather than the origin rule:
   * `https://attacker.invalid` constructed a working reader that would send the API key header
   * and the signed query string to it. The check is now a runtime membership test against the
   * allowlist the deployment configures, not a type brand and not caller discipline.
   */
  describe('no signed request reaches an unapproved origin', () => {
    it('cannot be constructed against a well-formed HTTPS origin the deployment does not approve', () => {
      const fetchImpl = neverCalled();
      for (const hostile of [
        'https://attacker.invalid',
        'https://testnet.binance.vision.attacker.invalid',
        'https://evil.testnet.binance.vision',
        'https://binance.vision',
        'https://xn--binnce-6va.vision',
      ]) {
        expect(
          () =>
            new ReadOnlyTransport({
              deployment: 'testnet',
              origin: readOrigin(hostile),
              fetch: fetchImpl,
              credential: readCredential(),
              now: () => new Date('2026-09-08T12:00:00.000Z'),
            }),
          hostile,
        ).toThrow(ContractViolation);
      }
      // The credential never left this process: nothing was ever sent.
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('names IDENTITY_ENVIRONMENT_MISMATCH when the origin is not this deployment’s', () => {
      try {
        new ReadOnlyTransport({
          deployment: 'testnet',
          origin: readOrigin('https://attacker.invalid'),
          fetch: neverCalled(),
          credential: readCredential(),
          now: () => new Date(),
        });
        expect.unreachable('a hostile HTTPS origin must not construct a reader');
      } catch (error) {
        expect((error as ContractViolation).reason).toBe('IDENTITY_ENVIRONMENT_MISMATCH');
      }
    });

    it('refuses the live host for a deployment that is not production-read-only', () => {
      // A testnet deployment pointed at real money is the mistake the allowlist exists for.
      expect(
        () =>
          new ReadOnlyTransport({
            deployment: 'testnet',
            origin: readOrigin('https://api.binance.com'),
            fetch: neverCalled(),
            credential: readCredential(),
            now: () => new Date(),
          }),
      ).toThrow(ContractViolation);
    });

    it('accepts each deployment’s own approved origin, so the rule is a bound and not a ban', () => {
      // Positive controls, one per environment.
      for (const [deployment, origin] of [
        ['testnet', 'https://testnet.binance.vision'],
        ['production-read-only', 'https://api.binance.com'],
        ['local', 'http://127.0.0.1:9443'],
        ['local', 'http://localhost:9443'],
      ] as const) {
        expect(
          () =>
            new ReadOnlyTransport({
              deployment,
              origin: readOrigin(origin),
              fetch: neverCalled(),
              credential: readCredential(),
              now: () => new Date(),
            }),
          `${deployment} ${origin}`,
        ).not.toThrow();
      }
    });

    it('sends every request, public or signed, to the approved origin only', async () => {
      const { fetchImpl, seen } = recording();
      const transport = transportWith(fetchImpl);

      // Hostile values in every caller-controlled position.
      await transport.read('serverTime', {});
      await transport
        .read('order', { symbol: 'https://attacker.invalid/api/v3/account', orderId: '1' })
        .catch(() => undefined);
      await transport.read('myTrades', { symbol: '//attacker.invalid' }).catch(() => undefined);

      expect(new Set(seen.map((request) => new URL(request.url).origin))).toEqual(
        new Set([TESTNET.origin]),
      );
    });

    it('refuses a redirect rather than following it to wherever it points', async () => {
      // A 302 to a hostile host would replay the signed query string there.
      const { fetchImpl } = recording(() =>
        respond('', {
          status: 302,
          headers: { location: 'https://attacker.invalid/api/v3/account' },
        }),
      );
      const failure = await transportWith(fetchImpl)
        .read('account', {})
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ReadFailure);
      expect((failure as ReadFailure).reason).toBe('SOURCE_UNAVAILABLE');
    });

    it('asks fetch not to follow redirects itself', async () => {
      const { fetchImpl, seen } = recording();
      await transportWith(fetchImpl).read('serverTime', {});
      expect(seen[0]?.redirect).toBe('error');
    });
  });

  describe('the clock', () => {
    it('refuses to sign against an invalid clock rather than sending timestamp=NaN', async () => {
      const fetchImpl = neverCalled();
      const transport = new ReadOnlyTransport({
        deployment: 'testnet',
        origin: TESTNET,
        fetch: fetchImpl,
        credential: readCredential(),
        now: () => new Date(Number.NaN),
      });
      // The venue would reject it — but only after the request had already carried the
      // credential across the network.
      await expect(transport.read('account', {})).rejects.toThrow(ContractViolation);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a public read against an invalid clock too', async () => {
      // A public read needs no signed timestamp, but its result still promises a request
      // interval. Returning an Invalid Date as provenance would put a non-time into the
      // evidence record, where it reads as a measurement rather than a fault.
      const fetchImpl = neverCalled();
      const transport = new ReadOnlyTransport({
        deployment: 'testnet',
        origin: TESTNET,
        fetch: fetchImpl,
        credential: readCredential(),
        now: () => new Date(Number.NaN),
      });
      await expect(transport.read('serverTime', {})).rejects.toThrow(ContractViolation);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('signs with the same instant it records as the interval start', () => {
      // Reading the clock twice would let the value that was signed differ from the value
      // recorded, and the recorded interval would then not describe the request that was made.
      const { fetchImpl, seen } = recording(() => respond([]));
      let reads = 0;
      const transport = new ReadOnlyTransport({
        deployment: 'testnet',
        origin: TESTNET,
        fetch: fetchImpl,
        credential: readCredential(),
        now: () => new Date(Date.parse('2026-09-08T12:00:00.000Z') + reads++ * 5_000),
      });
      return transport.read('openOrders', {}).then((result) => {
        const signed = new URL(seen[0]?.url ?? '').searchParams.get('timestamp');
        expect(signed).toBe(String(result.requestedAt.getTime()));
      });
    });

    it('refuses a result whose interval runs backwards', async () => {
      const clock = [new Date('2026-09-08T12:00:00.000Z'), new Date('2026-09-08T11:59:59.000Z')];
      let tick = 0;
      const { fetchImpl } = recording(() => respond([]));
      const transport = new ReadOnlyTransport({
        deployment: 'testnet',
        origin: TESTNET,
        fetch: fetchImpl,
        credential: readCredential(),
        now: () => clock[Math.min(tick++, clock.length - 1)] ?? new Date(0),
      });
      await expect(transport.read('openOrders', {})).rejects.toThrow(/moved backwards/);
    });

    it('accepts an interval of zero, which a fast local answer really produces', async () => {
      // The positive control: not-backwards, not strictly-increasing.
      const { fetchImpl } = recording(() => respond([]));
      const result = await transportWith(fetchImpl).read('openOrders', {});
      expect(result.respondedAt.getTime()).toBe(result.requestedAt.getTime());
    });
  });

  /**
   * Venue identities are text, not arithmetic.
   *
   * `orderId` and trade ids routinely exceed Number.MAX_SAFE_INTEGER, which is why the
   * decoders keep them as strings. A bound that coerced them would round a legitimate id into
   * a different one, and rounding a cursor changes which page of history is fetched.
   */
  describe('venue identities and cursors', () => {
    it('accepts an identity far beyond the safe integer range', async () => {
      const { fetchImpl, seen } = recording(() => respond([]));
      const cursor = '90071992547409931234';
      expect(Number.isSafeInteger(Number(cursor))).toBe(false);
      await transportWith(fetchImpl).read('myTrades', { symbol: 'BTCUSDT', fromId: cursor });
      // Sent verbatim: not rounded, not reformatted.
      expect(new URL(seen[0]?.url ?? '').searchParams.get('fromId')).toBe(cursor);
    });

    it('accepts a large orderId on an order lookup', async () => {
      const { fetchImpl, seen } = recording(() => respond({}));
      const id = '18446744073709551615';
      await transportWith(fetchImpl)
        .read('order', { symbol: 'BTCUSDT', orderId: id })
        .catch(() => undefined);
      expect(new URL(seen[0]?.url ?? '').searchParams.get('orderId')).toBe(id);
    });

    it('refuses an identity that is not canonical digits', async () => {
      const fetchImpl = neverCalled();
      const transport = transportWith(fetchImpl);
      for (const value of ['-1', '1.5', '1e3', '0x10', '', ' ', 'abc', '007']) {
        await expect(
          transport.read('myTrades', { symbol: 'BTCUSDT', fromId: value }),
          JSON.stringify(value),
        ).rejects.toThrow(ContractViolation);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  /**
   * "Either orderId or origClientOrderId must be sent."
   *
   * A query with neither is not a lookup of a specific order. The venue rejects it, and
   * spending the request's weight to learn that is the mistake this check avoids.
   */
  describe('order lookup identity', () => {
    it('refuses a lookup with neither identifier', async () => {
      const fetchImpl = neverCalled();
      await expect(transportWith(fetchImpl).read('order', { symbol: 'BTCUSDT' })).rejects.toThrow(
        /orderId or origClientOrderId/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('accepts either identifier alone', async () => {
      for (const parameters of [
        { symbol: 'BTCUSDT', orderId: '100234' },
        { symbol: 'BTCUSDT', origClientOrderId: 'capitaldesk-1' },
      ]) {
        const { fetchImpl } = recording(() => respond({}));
        await transportWith(fetchImpl)
          .read('order', parameters)
          .catch(() => undefined);
        expect(fetchImpl, JSON.stringify(parameters)).toHaveBeenCalledOnce();
      }
    });

    it('accepts both together, which the venue documents as its own cross-check', async () => {
      // "the orderId is searched first, then the origClientOrderId from that result is checked
      // against that order." Stricter than either alone, so permitted rather than refused.
      const { fetchImpl, seen } = recording(() => respond({}));
      await transportWith(fetchImpl)
        .read('order', {
          symbol: 'BTCUSDT',
          orderId: '100234',
          origClientOrderId: 'capitaldesk-1',
        })
        .catch(() => undefined);
      const url = new URL(seen[0]?.url ?? '');
      expect(url.searchParams.get('orderId')).toBe('100234');
      expect(url.searchParams.get('origClientOrderId')).toBe('capitaldesk-1');
    });
  });

  describe('failure classification', () => {
    it('reports HTTP 429 as a rate limit carrying the venue Retry-After', async () => {
      const { fetchImpl } = recording(() =>
        respond(
          { code: -1003, msg: 'Too many requests.' },
          { status: 429, headers: { 'retry-after': '61' } },
        ),
      );
      const failure = (await transportWith(fetchImpl)
        .read('account', {})
        .catch((error: unknown) => error)) as ReadFailure;
      expect(failure.reason).toBe('SOURCE_RATE_LIMITED');
      expect(failure.status).toBe(429);
      expect(failure.retryAfterSeconds).toBe(61);
    });

    it('reports HTTP 418 as a rate limit and accepts a three-day ban instruction', async () => {
      const { fetchImpl } = recording(() =>
        respond('', { status: 418, headers: { 'retry-after': '259200' } }),
      );
      const failure = (await transportWith(fetchImpl)
        .read('account', {})
        .catch((error: unknown) => error)) as ReadFailure;
      expect(failure.status).toBe(418);
      expect(failure.retryAfterSeconds).toBe(259_200);
    });

    it('reports a 5xx as unavailable, never as an empty result', async () => {
      const { fetchImpl } = recording(() => respond('', { status: 503 }));
      const failure = (await transportWith(fetchImpl)
        .read('myTrades', { symbol: 'BTCUSDT' })
        .catch((error: unknown) => error)) as ReadFailure;
      expect(failure.reason).toBe('SOURCE_UNAVAILABLE');
      expect(failure.status).toBe(503);
    });

    it('reports a transport throw as unavailable, with the cause redacted', async () => {
      const fetchImpl = vi.fn(() =>
        Promise.reject(new Error('connect ECONNREFUSED, signature=abcdef0123456789')),
      ) as unknown as typeof fetch;
      const failure = (await transportWith(fetchImpl)
        .read('account', {})
        .catch((error: unknown) => error)) as ReadFailure;
      expect(failure.reason).toBe('SOURCE_UNAVAILABLE');
      expect(failure.message).not.toContain('abcdef0123456789');
    });

    it('reports a venue rejection with its exact code, which callers apply rules to', async () => {
      const { fetchImpl } = recording(() =>
        respond({ code: -2013, msg: 'Order does not exist.' }, { status: 400 }),
      );
      const failure = (await transportWith(fetchImpl)
        .read('order', { symbol: 'BTCUSDT', orderId: '1' })
        .catch((error: unknown) => error)) as ReadFailure;
      // T-029: one of these must never release a reservation, and only the code says so.
      expect(failure.venueCode).toBe(-2013);
    });

    it('reports a 4xx with an unreadable body as a schema failure, not a rejection', async () => {
      const { fetchImpl } = recording(() => respond('<html>gateway</html>', { status: 400 }));
      const failure = (await transportWith(fetchImpl)
        .read('account', {})
        .catch((error: unknown) => error)) as ReadFailure;
      expect(failure.reason).toBe('SOURCE_SCHEMA_UNRECOGNIZED');
    });
  });

  describe('provenance', () => {
    it('records the request interval, the venue headers and a digest of the exact body', async () => {
      const clock = [new Date('2026-09-08T12:00:00.000Z'), new Date('2026-09-08T12:00:00.250Z')];
      let tick = 0;
      const { fetchImpl } = recording(() =>
        respond('{"serverTime":1}', { headers: { 'x-mbx-used-weight-1m': '20' } }),
      );
      const transport = new ReadOnlyTransport({
        deployment: 'testnet',
        origin: TESTNET,
        fetch: fetchImpl,
        credential: readCredential(),
        now: () => clock[Math.min(tick++, clock.length - 1)] ?? new Date(0),
      });

      const result = await transport.read('serverTime', {});
      expect(result.requestedAt.toISOString()).toBe('2026-09-08T12:00:00.000Z');
      expect(result.respondedAt.toISOString()).toBe('2026-09-08T12:00:00.250Z');
      expect(result.endpoint).toBe('serverTime');
      expect(result.weight).toBe(1);
      expect(result.headers).toEqual({
        'content-type': 'application/json',
        'x-mbx-used-weight-1m': '20',
      });
      // The digest is over the exact bytes, so an independent reader can recompute it. This
      // value came from `shasum -a 256` over the same body, not from the implementation.
      expect(result.body).toBe('{"serverTime":1}');
      expect(result.bodyDigest).toBe(
        'sha256:20fdf3538c7e5a183d8bb95f330e20dcec7cf5453dc9f0a5d9f0a252c91b8eba',
      );
    });

    it('never records credential material in the recorded request URL', async () => {
      const { fetchImpl } = recording(() => respond([]));
      const result = await transportWith(fetchImpl).read('openOrders', {});
      expect(result.requestUrl).toContain('signature=REDACTED');
      expect(result.requestUrl).not.toContain('FIXTURE-SIGNATURE-VALUE');
      expect(JSON.stringify(result)).not.toContain('FIXTURE-API-KEY-VALUE');
    });

    it('charges the documented weight for the call it actually made', async () => {
      const { fetchImpl } = recording(() => respond([]));
      const transport = transportWith(fetchImpl);
      expect((await transport.read('openOrders', {})).weight).toBe(80);
      expect((await transport.read('openOrders', { symbol: 'BTCUSDT' })).weight).toBe(6);
    });
  });

  describe('bounded request parameters', () => {
    it('refuses a myTrades window wider than the venue documents', async () => {
      const fetchImpl = neverCalled();
      const failure = await transportWith(fetchImpl)
        .read('myTrades', {
          symbol: 'BTCUSDT',
          startTime: '0',
          endTime: String(24 * 60 * 60 * 1000 + 1),
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ContractViolation);
      // Refused before it is sent: a request the venue will reject is not worth its weight.
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('accepts a window exactly at the documented bound', async () => {
      const { fetchImpl } = recording(() => respond([]));
      await transportWith(fetchImpl).read('myTrades', {
        symbol: 'BTCUSDT',
        startTime: '0',
        endTime: String(24 * 60 * 60 * 1000),
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('refuses a page size above the documented maximum, and accepts it exactly', async () => {
      const fetchImpl = neverCalled();
      await expect(
        transportWith(fetchImpl).read('myTrades', { symbol: 'BTCUSDT', limit: '1001' }),
      ).rejects.toThrow(ContractViolation);
      expect(fetchImpl).not.toHaveBeenCalled();

      const accepted = recording(() => respond([]));
      await transportWith(accepted.fetchImpl).read('myTrades', {
        symbol: 'BTCUSDT',
        limit: '1000',
      });
      expect(accepted.fetchImpl).toHaveBeenCalledOnce();
    });

    /**
     * `Number()` accepts '', ' ', '1.5', '1e3', '-1' and 'Infinity'. A bound built on it lets
     * a fractional cursor or a non-finite window through, to be rejected by the venue at the
     * cost of the request's full weight — or worse, accepted, silently changing which page of
     * an account's trade history was fetched.
     */
    it('refuses a numeric parameter that is not a non-negative integer', async () => {
      const fetchImpl = neverCalled();
      const transport = transportWith(fetchImpl);
      for (const [field, value] of [
        ['limit', ''],
        ['limit', ' '],
        ['limit', '1.5'],
        ['limit', '1e3'],
        ['limit', '-1'],
        ['limit', 'Infinity'],
        ['limit', 'NaN'],
        ['limit', '0'],
        ['startTime', 'yesterday'],
        ['startTime', '-1'],
        ['endTime', '1.5'],
      ] as const) {
        await expect(
          transport.read('myTrades', { symbol: 'BTCUSDT', [field]: value }),
          `${field}=${value}`,
        ).rejects.toThrow(ContractViolation);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('accepts a legitimate cursor and page size', async () => {
      // The positive control: the bound refuses shapes, not values.
      const { fetchImpl, seen } = recording(() => respond([]));
      await transportWith(fetchImpl).read('myTrades', {
        symbol: 'BTCUSDT',
        fromId: '0',
        limit: '500',
      });
      const url = new URL(seen[0]?.url ?? '');
      expect(url.searchParams.get('fromId')).toBe('0');
      expect(url.searchParams.get('limit')).toBe('500');
    });

    it('refuses a request missing a parameter the venue documents as mandatory', async () => {
      const fetchImpl = neverCalled();
      // `order` requires a symbol. Sending it without one spends weight to be rejected.
      await expect(transportWith(fetchImpl).read('order', { orderId: '1' })).rejects.toThrow(
        ContractViolation,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
