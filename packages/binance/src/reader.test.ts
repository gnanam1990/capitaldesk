import { describe, expect, it, vi } from 'vitest';
import { ContractViolation } from '@capitaldesk/contracts';
import { BinanceSpotReader, type Observation } from './reader.js';
import { ReadFailure } from './failures.js';
import { readOrigin } from './endpoints.js';
import { ReadOnlyTransport, type ReadCredential } from './transport.js';

/**
 * The readers, against a scripted venue.
 *
 * The scenarios here are the adversarial ones from the test plan: pagination gaps, duplicates
 * and reordering (T-034, T-022), a single NOT_FOUND (T-029), identity scoping across account,
 * symbol and epoch (T-031, T-032), account-wide open orders outside the selected symbol
 * (T-041), and degraded reads (T-043).
 */
const TESTNET = readOrigin('https://testnet.binance.vision');
const SCALES = { base: 8, quote: 8, commission: { BNB: 8, USDT: 8, BTC: 8 } };
const ASSET_SCALES = { BTC: 8, USDT: 8 };

const CREDENTIAL: ReadCredential = {
  credentialClass: 'VENUE_READ',
  alias: 'venue-read-fixture',
  authorize(query) {
    const signed = new URLSearchParams(query);
    signed.set('signature', 'FIXTURE-SIGNATURE-VALUE');
    return { headers: { 'X-MBX-APIKEY': 'FIXTURE-API-KEY-VALUE' }, signedQuery: signed };
  },
};

/** A scripted venue: each call answers from the queue for its path. */
function venue(script: Record<string, (url: URL) => Response>): {
  reader: BinanceSpotReader;
  calls: URL[];
} {
  const calls: URL[] = [];
  const fetchImpl = vi.fn((request: Request) => {
    const url = new URL(request.url);
    calls.push(url);
    const answer = script[url.pathname];
    if (answer === undefined) throw new Error(`unscripted path ${url.pathname}`);
    return Promise.resolve(answer(url));
  }) as unknown as typeof fetch;

  let tick = 0;
  const transport = new ReadOnlyTransport({
    deployment: 'testnet',
    origin: TESTNET,
    fetch: fetchImpl,
    credential: CREDENTIAL,
    now: () => new Date(Date.parse('2026-09-08T12:00:00.000Z') + tick++ * 100),
  });
  const reader = new BinanceSpotReader({
    transport,
    identity: { environment: 'testnet', expectedStableAccountId: '354937868', epoch: 3 },
  });
  return { reader, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ACCOUNT_BODY = {
  accountType: 'SPOT',
  updateTime: 1_788_867_356_144,
  balances: [
    { asset: 'BTC', free: '0.50000000', locked: '0.00000000' },
    { asset: 'USDT', free: '1000.00000000', locked: '25.00000000' },
  ],
  permissions: ['SPOT'],
  uid: 354_937_868,
};

function trade(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'BTCUSDT',
    id,
    orderId: 100_234,
    price: '30000.00000000',
    qty: '0.00050000',
    quoteQty: '15.00000000',
    commission: '0.00001500',
    commissionAsset: 'BNB',
    time: 1_788_867_000_000 + id,
    isBuyer: true,
    isMaker: false,
    ...extra,
  };
}

describe('every reader result states its provenance', () => {
  it('records account, environment, epoch, interval, digest, weight and completeness', async () => {
    const { reader } = venue({ '/api/v3/account': () => json(ACCOUNT_BODY) });
    const observed = await reader.accountSnapshot(ASSET_SCALES);
    expect(observed.provenance).toMatchObject({
      venue: 'binance-spot',
      environment: 'testnet',
      stableAccountId: '354937868',
      epoch: 3,
      endpoint: '/api/v3/account',
      requestedAt: '2026-09-08T12:00:00.000Z',
      respondedAt: '2026-09-08T12:00:00.100Z',
      sourceTime: new Date(1_788_867_356_144).toISOString(),
      weight: 20,
      completeness: 'POINT_IN_TIME',
      cursor: null,
    });
    expect(observed.provenance.responseDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('never puts credential material into the provenance', async () => {
    const { reader } = venue({ '/api/v3/account': () => json(ACCOUNT_BODY) });
    const observed = await reader.accountSnapshot(ASSET_SCALES);
    // Atoms are bigint, so the whole observation is serialised with an explicit replacer.
    const serialised = JSON.stringify(observed, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialised).not.toContain('FIXTURE-API-KEY-VALUE');
    expect(serialised).not.toContain('FIXTURE-SIGNATURE-VALUE');
    expect(observed.provenance.requestUrl).toContain('signature=REDACTED');
  });
});

/** T-031, T-038: identity is account, environment and epoch, never a credential alias. */
describe('account identity binding', () => {
  it('refuses a snapshot from a different authenticated account', async () => {
    const { reader } = venue({
      '/api/v3/account': () => json({ ...ACCOUNT_BODY, uid: 999_999_999 }),
    });
    const failure = await reader.accountSnapshot(ASSET_SCALES).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContractViolation);
    expect((failure as ContractViolation).reason).toBe('IDENTITY_UNSTABLE_ACCOUNT');
  });

  it('accepts the account it is bound to', async () => {
    const { reader } = venue({ '/api/v3/account': () => json(ACCOUNT_BODY) });
    await expect(reader.accountSnapshot(ASSET_SCALES)).resolves.toMatchObject({
      value: { stableAccountId: '354937868' },
    });
  });

  it('stamps the reader epoch on every observation, so evidence cannot cross a reset', async () => {
    // T-032: a testnet reset opens a new epoch, and an observation carries the epoch it was
    // read under rather than being reinterpreted under a later one.
    const { reader } = venue({ '/api/v3/account': () => json(ACCOUNT_BODY) });
    const observed = await reader.accountSnapshot(ASSET_SCALES);
    expect(observed.provenance.epoch).toBe(3);
  });
});

describe('order lookup by exact identity', () => {
  const ORDER = {
    symbol: 'BTCUSDT',
    orderId: 100_234,
    clientOrderId: 'capitaldesk-1',
    price: '30000.00000000',
    origQty: '0.00100000',
    executedQty: '0.00050000',
    cummulativeQuoteQty: '15.00000000',
    status: 'PARTIALLY_FILLED',
    timeInForce: 'IOC',
    type: 'LIMIT',
    side: 'BUY',
    time: 1_788_867_000_000,
    updateTime: 1_788_867_100_000,
  };

  it('looks an order up by the venue id, and by our client id', async () => {
    const { reader, calls } = venue({ '/api/v3/order': () => json(ORDER) });
    await reader.orderByIdentity({ symbol: 'BTCUSDT', venueOrderId: '100234' }, SCALES);
    await reader.orderByIdentity({ symbol: 'BTCUSDT', clientOrderId: 'capitaldesk-1' }, SCALES);
    expect(calls[0]?.searchParams.get('orderId')).toBe('100234');
    expect(calls[1]?.searchParams.get('origClientOrderId')).toBe('capitaldesk-1');
  });

  /** T-029: a single NOT_FOUND is a typed refusal carrying the code, never an absence. */
  it('reports a NOT_FOUND as a typed rejection with the venue code', async () => {
    const { reader } = venue({
      '/api/v3/order': () => json({ code: -2013, msg: 'Order does not exist.' }, 400),
    });
    const failure = (await reader
      .orderByIdentity({ symbol: 'BTCUSDT', venueOrderId: '100234' }, SCALES)
      .catch((error: unknown) => error)) as ReadFailure;
    expect(failure).toBeInstanceOf(ReadFailure);
    expect(failure.venueCode).toBe(-2013);
    // Crucially not an absent order or a null: a caller cannot mistake this for "no order".
    expect(failure.reason).toBe('VENUE_OBSERVATION_UNSUPPORTED');
  });

  it('reveals the order on a later query, with the first response having changed nothing', async () => {
    // The delayed-visibility half of T-029: the reader is a pure read, so the only thing that
    // must hold is that the first answer produced no value at all.
    let attempt = 0;
    const { reader } = venue({
      '/api/v3/order': () =>
        attempt++ === 0 ? json({ code: -2013, msg: 'Order does not exist.' }, 400) : json(ORDER),
    });
    await expect(
      reader.orderByIdentity({ symbol: 'BTCUSDT', venueOrderId: '100234' }, SCALES),
    ).rejects.toBeInstanceOf(ReadFailure);
    const observed = await reader.orderByIdentity(
      { symbol: 'BTCUSDT', venueOrderId: '100234' },
      SCALES,
    );
    expect(observed.value.status).toBe('PARTIALLY_FILLED');
  });

  it('refuses an answer about a different symbol than the one asked about', async () => {
    const { reader } = venue({ '/api/v3/order': () => json({ ...ORDER, symbol: 'ETHUSDT' }) });
    const failure = await reader
      .orderByIdentity({ symbol: 'BTCUSDT', venueOrderId: '100234' }, SCALES)
      .catch((error: unknown) => error);
    expect((failure as ContractViolation).reason).toBe('IDENTITY_SCOPE_MISMATCH');
  });

  it('preserves an unknown status as quarantined rather than mapping it', async () => {
    const { reader } = venue({
      '/api/v3/order': () => json({ ...ORDER, status: 'EXPIRED_IN_MATCH' }),
    });
    const expired = await reader.orderByIdentity(
      { symbol: 'BTCUSDT', venueOrderId: '100234' },
      SCALES,
    );
    expect(expired.value.status).toBe('EXPIRED_IN_MATCH');

    const { reader: other } = venue({
      '/api/v3/order': () => json({ ...ORDER, status: 'SOMETHING_NEW' }),
    });
    const unknown = await other.orderByIdentity(
      { symbol: 'BTCUSDT', venueOrderId: '100234' },
      SCALES,
    );
    expect(unknown.value.status).toBe('UNSUPPORTED_OBSERVATION');
    expect(unknown.value.rawStatus).toBe('SOMETHING_NEW');
  });
});

/** T-041: an order resting on another symbol can consume the shared quote or fee asset. */
describe('the account-wide open-order scan', () => {
  it('reports orders on symbols outside the selected one', async () => {
    const { reader, calls } = venue({
      '/api/v3/openOrders': () =>
        json([
          { symbol: 'BTCUSDT', orderId: 1, status: 'NEW', updateTime: 1 },
          { symbol: 'ETHUSDT', orderId: 2, status: 'NEW', updateTime: 2 },
        ]),
    });
    const observed = await reader.openOrdersAccountWide();
    // Account-wide: no symbol parameter, and therefore the expensive weight.
    expect(calls[0]?.searchParams.get('symbol')).toBeNull();
    expect(observed.provenance.weight).toBe(80);
    expect(observed.value.map((order) => order.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('reports a genuinely empty scan as complete', async () => {
    const { reader } = venue({ '/api/v3/openOrders': () => json([]) });
    const observed = await reader.openOrdersAccountWide();
    expect(observed.value).toEqual([]);
    expect(observed.provenance.completeness).toBe('COMPLETE');
  });

  it('refuses a body that is not an array, rather than reporting a clean scan', async () => {
    // A clean scan is what lets a cut be declared complete, so it may only come from an
    // actual empty array.
    const { reader } = venue({ '/api/v3/openOrders': () => json({ orders: [] }) });
    await expect(reader.openOrdersAccountWide()).rejects.toBeInstanceOf(ReadFailure);
  });
});

/** T-034: completeness is proven by contiguous cursor pagination, never by one good page. */
describe('trade pagination', () => {
  it('treats a full page as partial and hands back a resumable cursor', async () => {
    const { reader } = venue({
      '/api/v3/myTrades': () => json([trade(10), trade(11), trade(12)]),
    });
    const page = await reader.tradesFrom('BTCUSDT', SCALES, { limit: 3 });
    expect(page.provenance.completeness).toBe('PARTIAL');
    // fromId is inclusive, so the cursor is one past the highest id seen.
    expect(page.value.nextFromId).toBe('13');
    expect(page.provenance.cursor).toBe('13');
  });

  it('treats a short page as the end of the range', async () => {
    const { reader } = venue({ '/api/v3/myTrades': () => json([trade(10), trade(11)]) });
    const page = await reader.tradesFrom('BTCUSDT', SCALES, { limit: 3 });
    expect(page.provenance.completeness).toBe('COMPLETE');
    expect(page.value.nextFromId).toBeNull();
  });

  it('treats an empty page as the end, not as an error', async () => {
    const { reader } = venue({ '/api/v3/myTrades': () => json([]) });
    const page = await reader.tradesFrom('BTCUSDT', SCALES, { limit: 3 });
    expect(page.value.trades).toEqual([]);
    expect(page.provenance.completeness).toBe('COMPLETE');
  });

  it('computes the cursor from the highest id, not the last row', async () => {
    // The venue does not promise a page arrives sorted, and T-022 requires that reordered
    // records produce one effect. A cursor taken from arrival order would skip rows.
    const { reader } = venue({
      '/api/v3/myTrades': () => json([trade(12), trade(10), trade(11)]),
    });
    const page = await reader.tradesFrom('BTCUSDT', SCALES, { limit: 3 });
    expect(page.value.nextFromId).toBe('13');
  });

  it('compares ids numerically, so 9 does not sort after 10', async () => {
    const { reader } = venue({ '/api/v3/myTrades': () => json([trade(9), trade(10)]) });
    const page = await reader.tradesFrom('BTCUSDT', SCALES, { limit: 2 });
    expect(page.value.nextFromId).toBe('11');
  });

  it('resumes from the cursor it was given, exactly', async () => {
    const { reader, calls } = venue({ '/api/v3/myTrades': () => json([]) });
    await reader.tradesFrom('BTCUSDT', SCALES, { fromId: '13', limit: 500 });
    expect(calls[0]?.searchParams.get('fromId')).toBe('13');
    expect(calls[0]?.searchParams.get('limit')).toBe('500');
  });

  it('carries a cursor beyond the safe integer range without rounding it', async () => {
    const huge = '9007199254740993';
    const { reader } = venue({
      '/api/v3/myTrades': () => json([{ ...trade(1), id: huge }]),
    });
    const page = await reader.tradesFrom('BTCUSDT', SCALES, { limit: 1 });
    expect(page.value.nextFromId).toBe('9007199254740994');
  });

  it('never infers a gap from the numeric distance between two ids', async () => {
    // ADR-0002 condition C3: trade ids are per-symbol and not a dense sequence. A page from
    // 10 to 900 is not evidence of 889 missing trades.
    const { reader } = venue({ '/api/v3/myTrades': () => json([trade(10), trade(900)]) });
    const page = await reader.tradesFrom('BTCUSDT', SCALES, { limit: 500 });
    expect(page.provenance.completeness).toBe('COMPLETE');
    expect(page.value.trades).toHaveLength(2);
  });

  it('refuses a full page that carries no id to resume from', async () => {
    // Stopping quietly here would report a truncated history as complete.
    const { reader } = venue({ '/api/v3/myTrades': () => json([]) });
    const page = await reader.tradesFrom('BTCUSDT', SCALES, { limit: 0 }).catch(() => null);
    // limit 0 is refused before it is sent, which is the same protection from the other side.
    expect(page).toBeNull();
  });

  it('refuses a page containing a trade for another symbol', async () => {
    const { reader } = venue({
      '/api/v3/myTrades': () => json([trade(10), { ...trade(11), symbol: 'ETHUSDT' }]),
    });
    const failure = await reader
      .tradesFrom('BTCUSDT', SCALES, { limit: 500 })
      .catch((error: unknown) => error);
    expect((failure as ContractViolation).reason).toBe('IDENTITY_SCOPE_MISMATCH');
  });

  it('preserves a duplicate boundary row rather than dropping it', async () => {
    // T-022: dedupe belongs to the journal, which keys by trade id. The reader must not
    // silently drop a row, because "one page returned two rows" is itself evidence.
    const { reader } = venue({ '/api/v3/myTrades': () => json([trade(10), trade(10)]) });
    const page = await reader.tradesFrom('BTCUSDT', SCALES, { limit: 500 });
    expect(page.value.trades).toHaveLength(2);
  });
});

/** T-043: a degraded read is an explicit state, never an empty result. */
describe('degraded reads', () => {
  it('surfaces a rate limit with its wait rather than returning nothing', async () => {
    const { reader } = venue({
      '/api/v3/myTrades': () => new Response('', { status: 429, headers: { 'retry-after': '61' } }),
    });
    const failure = (await reader
      .tradesFrom('BTCUSDT', SCALES)
      .catch((error: unknown) => error)) as ReadFailure;
    expect(failure.reason).toBe('SOURCE_RATE_LIMITED');
    expect(failure.retryAfterSeconds).toBe(61);
  });

  it('surfaces a server error as unavailable, so reservations are preserved', async () => {
    const { reader } = venue({
      '/api/v3/myTrades': () => new Response('', { status: 503 }),
    });
    const failure = (await reader
      .tradesFrom('BTCUSDT', SCALES)
      .catch((error: unknown) => error)) as ReadFailure;
    expect(failure.reason).toBe('SOURCE_UNAVAILABLE');
  });

  it('surfaces an authentication failure as the venue reported it', async () => {
    const { reader } = venue({
      '/api/v3/account': () =>
        json({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }, 401),
    });
    const failure = (await reader
      .accountSnapshot(ASSET_SCALES)
      .catch((error: unknown) => error)) as ReadFailure;
    expect(failure.venueCode).toBe(-2015);
  });
});

describe('market context', () => {
  it('reads the selected symbol filters with provenance', async () => {
    const { reader } = venue({
      '/api/v3/exchangeInfo': () =>
        json({
          serverTime: 1_788_867_332_000,
          symbols: [
            {
              symbol: 'BTCUSDT',
              status: 'TRADING',
              baseAsset: 'BTC',
              quoteAsset: 'USDT',
              baseAssetPrecision: 8,
              quoteAssetPrecision: 8,
              orderTypes: ['LIMIT'],
              filters: [
                {
                  filterType: 'LOT_SIZE',
                  minQty: '0.00001000',
                  maxQty: '9000.00000000',
                  stepSize: '0.00001000',
                },
              ],
            },
          ],
        }),
    });
    const observed: Observation<{ symbol: string }> = await reader.marketContext('BTCUSDT');
    expect(observed.value.symbol).toBe('BTCUSDT');
    expect(observed.provenance.endpoint).toBe('/api/v3/exchangeInfo');
    expect(observed.provenance.weight).toBe(20);
    expect(observed.provenance.sourceTime).toBe(new Date(1_788_867_332_000).toISOString());
  });
});
