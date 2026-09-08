import { describe, expect, it } from 'vitest';
import { ReadFailure } from './failures.js';
import {
  KNOWN_ORDER_STATUSES,
  SUPPORTED_ORDER_STATUSES,
  decodeAccount,
  decodeExchangeInfo,
  decodeOpenOrders,
  decodeOrder,
  decodeTrades,
  decodeVenueError,
  mapOrderStatus,
  parseScaledAtoms,
} from './decode.js';

/**
 * Decoding is where an unrecognised fact becomes either evidence or an invention.
 *
 * The rule from ADR-0004: what we may submit is narrow, what we may observe is wide. An
 * unknown status is preserved and quarantined, never mapped onto the nearest familiar one.
 * And every quantity crosses into integer atoms exactly — no float, no parseFloat, no
 * Math.round — because that boundary is where money silently loses precision.
 */
describe('parseScaledAtoms', () => {
  it('converts a decimal string to integer atoms at the venue scale', () => {
    expect(parseScaledAtoms('0.00001000', 8)).toBe(1_000n);
    expect(parseScaledAtoms('9000.00000000', 8)).toBe(900_000_000_000n);
    expect(parseScaledAtoms('4723846.89208129', 8)).toBe(472_384_689_208_129n);
  });

  it('accepts an integer with no decimal point, and a zero', () => {
    expect(parseScaledAtoms('5', 8)).toBe(500_000_000n);
    expect(parseScaledAtoms('0', 8)).toBe(0n);
    expect(parseScaledAtoms('0.00000000', 8)).toBe(0n);
  });

  it('pads a short fraction rather than misreading its magnitude', () => {
    // "0.1" at scale 8 is 10000000 atoms, not 1.
    expect(parseScaledAtoms('0.1', 8)).toBe(10_000_000n);
  });

  it('refuses a value with more precision than the scale, instead of rounding it away', () => {
    // Rounding here would silently discard money. The venue told us the scale; a value
    // outside it is a contradiction to surface, not a number to tidy.
    expect(() => parseScaledAtoms('0.000000001', 8)).toThrow(/precision/i);
  });

  it('refuses every shape that is not an exact decimal', () => {
    for (const value of ['', ' ', '1.2.3', '1e8', 'NaN', 'Infinity', '0x10', '1,5', '- 1', '.']) {
      expect(() => parseScaledAtoms(value, 8), JSON.stringify(value)).toThrow();
    }
  });

  it('handles a negative value exactly, without float error', () => {
    expect(parseScaledAtoms('-0.00000001', 8)).toBe(-1n);
  });

  it('is exact where a float would not be', () => {
    // 0.1 + 0.2 in binary floating point is the classic case; atoms are integers.
    expect(parseScaledAtoms('0.1', 8) + parseScaledAtoms('0.2', 8)).toBe(
      parseScaledAtoms('0.3', 8),
    );
  });

  it('preserves a value far beyond what a double can represent', () => {
    expect(parseScaledAtoms('123456789012345678.12345678', 8)).toBe(
      12_345_678_901_234_567_812_345_678n,
    );
  });
});

describe('order status mapping', () => {
  it('carries every status the venue documents', () => {
    expect(KNOWN_ORDER_STATUSES).toEqual([
      'NEW',
      'PENDING_NEW',
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCELED',
      'PENDING_CANCEL',
      'REJECTED',
      'EXPIRED',
      'EXPIRED_IN_MATCH',
    ]);
  });

  it('maps each supported status to itself', () => {
    for (const status of SUPPORTED_ORDER_STATUSES) {
      expect(mapOrderStatus(status), status).toEqual({ mapped: status, raw: status });
    }
  });

  it('preserves EXPIRED_IN_MATCH, which self-trade prevention produces', () => {
    // ADR-0004: a narrow submission policy does not make this impossible, because other
    // account or trade-group activity produces it.
    expect(mapOrderStatus('EXPIRED_IN_MATCH')).toEqual({
      mapped: 'EXPIRED_IN_MATCH',
      raw: 'EXPIRED_IN_MATCH',
    });
  });

  it('quarantines a documented status this build has no accounting for', () => {
    // PENDING_NEW is documented upstream but is not in this repository's
    // venue_orders_status_known CHECK. Adopting it silently would be an undesigned
    // accounting decision; the fail-closed answer preserves it raw.
    expect(mapOrderStatus('PENDING_NEW')).toEqual({
      mapped: 'UNSUPPORTED_OBSERVATION',
      raw: 'PENDING_NEW',
    });
  });

  it('quarantines an unknown future status instead of guessing the nearest one', () => {
    for (const status of ['SETTLED', 'PARTIALLY_CANCELED', 'FILLED_MAYBE', '']) {
      expect(mapOrderStatus(status), status).toEqual({
        mapped: 'UNSUPPORTED_OBSERVATION',
        raw: status,
      });
    }
  });
});

describe('decodeVenueError', () => {
  it('reads the documented {code, msg} envelope', () => {
    expect(decodeVenueError('{"code":-1121,"msg":"Invalid symbol."}')).toEqual({
      code: -1121,
      msg: 'Invalid symbol.',
    });
  });

  it('returns null for a body that is not one, rather than inventing a code', () => {
    for (const body of ['', 'not json', '{}', '{"code":"x","msg":"y"}', '[]', 'null']) {
      expect(decodeVenueError(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe('decodeAccount', () => {
  const ACCOUNT = {
    makerCommission: 15,
    takerCommission: 15,
    canTrade: true,
    canWithdraw: true,
    canDeposit: true,
    updateTime: 1_788_867_356_144,
    accountType: 'SPOT',
    balances: [
      { asset: 'BTC', free: '4723846.89208129', locked: '0.00000000' },
      { asset: 'USDT', free: '0.00000000', locked: '10.50000000' },
    ],
    permissions: ['SPOT'],
    uid: 354_937_868,
  };

  it('reads the stable account id, the balances and the venue clock', () => {
    const account = decodeAccount(JSON.stringify(ACCOUNT), 8);
    expect(account.stableAccountId).toBe('354937868');
    expect(account.accountType).toBe('SPOT');
    expect(account.updateTime).toBe(1_788_867_356_144);
    expect(account.balances).toEqual([
      { asset: 'BTC', freeAtoms: 472_384_689_208_129n, lockedAtoms: 0n },
      { asset: 'USDT', freeAtoms: 0n, lockedAtoms: 1_050_000_000n },
    ]);
  });

  it('keeps unknown extra fields out of the decoded value without failing', () => {
    // The venue adds fields. Refusing them would break on every upstream release; adopting
    // them would smuggle undecoded data into the accounting path.
    const account = decodeAccount(JSON.stringify({ ...ACCOUNT, somethingNew: true }), 8);
    expect(account).not.toHaveProperty('somethingNew');
    expect(account.stableAccountId).toBe('354937868');
  });

  it('refuses a response with no uid, because that is the account identity', () => {
    const { uid: _uid, ...noUid } = ACCOUNT;
    expect(() => decodeAccount(JSON.stringify(noUid), 8)).toThrow(ReadFailure);
  });

  it('refuses malformed JSON as a schema failure, never as an empty account', () => {
    // An empty balance list reads as "the account holds nothing", which is a lie that
    // releases capital.
    for (const body of ['', '{', 'null', '[]', '"a string"']) {
      const error = (() => {
        try {
          decodeAccount(body, 8);
          return null;
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error, JSON.stringify(body)).toBeInstanceOf(ReadFailure);
      expect((error as ReadFailure).reason).toBe('SOURCE_SCHEMA_UNRECOGNIZED');
    }
  });

  it('refuses a balance whose numbers are not exact decimals', () => {
    const broken = { ...ACCOUNT, balances: [{ asset: 'BTC', free: 4723846.89, locked: '0' }] };
    expect(() => decodeAccount(JSON.stringify(broken), 8)).toThrow(ReadFailure);
  });
});

describe('decodeExchangeInfo', () => {
  // The live BTCUSDT response, trimmed to the fields the reader consumes.
  const INFO = {
    serverTime: 1_788_867_332_000,
    symbols: [
      {
        symbol: 'BTCUSDT',
        status: 'TRADING',
        baseAsset: 'BTC',
        baseAssetPrecision: 8,
        quoteAsset: 'USDT',
        quoteAssetPrecision: 8,
        baseCommissionPrecision: 8,
        quoteCommissionPrecision: 8,
        orderTypes: ['LIMIT', 'LIMIT_MAKER', 'MARKET'],
        isSpotTradingAllowed: true,
        filters: [
          {
            filterType: 'PRICE_FILTER',
            minPrice: '0.01000000',
            maxPrice: '1000000.00000000',
            tickSize: '0.01000000',
          },
          {
            filterType: 'LOT_SIZE',
            minQty: '0.00001000',
            maxQty: '9000.00000000',
            stepSize: '0.00001000',
          },
          { filterType: 'NOTIONAL', minNotional: '5.00000000', maxNotional: '9000000.00000000' },
          { filterType: 'SOME_FUTURE_FILTER', limit: 3 },
        ],
      },
    ],
  };

  it('reads the actual scales and the filters as exact atoms', () => {
    const info = decodeExchangeInfo(JSON.stringify(INFO), 'BTCUSDT');
    expect(info.symbol).toBe('BTCUSDT');
    expect(info.status).toBe('TRADING');
    expect(info.baseAsset).toBe('BTC');
    expect(info.baseAssetPrecision).toBe(8);
    expect(info.quoteAssetPrecision).toBe(8);
    expect(info.price).toEqual({
      minAtoms: 1_000_000n,
      maxAtoms: 100_000_000_000_000n,
      tickAtoms: 1_000_000n,
    });
    expect(info.lot).toEqual({ minAtoms: 1_000n, maxAtoms: 900_000_000_000n, stepAtoms: 1_000n });
    expect(info.notional?.minAtoms).toBe(500_000_000n);
  });

  it('keeps every filter raw as well, including one it does not model', () => {
    // A filter change during a cut has to be detectable, and a filter this build does not
    // model must still be visible in the evidence.
    const info = decodeExchangeInfo(JSON.stringify(INFO), 'BTCUSDT');
    expect(info.rawFilters.map((f) => f['filterType'])).toEqual([
      'PRICE_FILTER',
      'LOT_SIZE',
      'NOTIONAL',
      'SOME_FUTURE_FILTER',
    ]);
  });

  it('refuses when the requested symbol is absent, rather than taking the first', () => {
    expect(() => decodeExchangeInfo(JSON.stringify(INFO), 'ETHUSDT')).toThrow(ReadFailure);
  });

  it('refuses a response with no symbols array', () => {
    expect(() => decodeExchangeInfo('{"serverTime":1}', 'BTCUSDT')).toThrow(ReadFailure);
  });
});

describe('decodeOrder and decodeOpenOrders', () => {
  const ORDER = {
    symbol: 'BTCUSDT',
    orderId: 100_234,
    orderListId: -1,
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
    isWorking: true,
    selfTradePreventionMode: 'NONE',
  };

  it('reads identity, status and exact cumulative quantities', () => {
    const order = decodeOrder(JSON.stringify(ORDER), { base: 8, quote: 8 });
    expect(order.venueOrderId).toBe('100234');
    expect(order.clientOrderId).toBe('capitaldesk-1');
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(order.rawStatus).toBe('PARTIALLY_FILLED');
    expect(order.executedBaseAtoms).toBe(50_000n);
    expect(order.cumulativeQuoteAtoms).toBe(1_500_000_000n);
  });

  it('refuses a JSON-number order id past the safe integer range', () => {
    // Beyond Number.MAX_SAFE_INTEGER a JSON number is already lossy by the time we see it, so
    // the decoder refuses rather than recording a corrupted identity that would correlate one
    // order's fills to another. The literal is computed, because writing it out is itself a
    // precision loss the linter rightly rejects.
    const huge = JSON.stringify({ ...ORDER, orderId: Number.MAX_SAFE_INTEGER + 2 });
    expect(() => decodeOrder(huge, { base: 8, quote: 8 })).toThrow(/safe integer|identity/i);
  });

  it('accepts a large id sent as a string, which is how it stays exact', () => {
    // The positive control: a string identity has no precision limit, so an id far past the
    // double range is kept verbatim rather than refused.
    const order = decodeOrder(JSON.stringify({ ...ORDER, orderId: '90071992547409931' }), {
      base: 8,
      quote: 8,
    });
    expect(order.venueOrderId).toBe('90071992547409931');
  });

  it('quarantines an unknown status but keeps the rest of the order readable', () => {
    const order = decodeOrder(JSON.stringify({ ...ORDER, status: 'SETTLED' }), {
      base: 8,
      quote: 8,
    });
    expect(order.status).toBe('UNSUPPORTED_OBSERVATION');
    expect(order.rawStatus).toBe('SETTLED');
    expect(order.executedBaseAtoms).toBe(50_000n);
  });

  it('treats a missing clientOrderId as absent, never as an empty correlation', () => {
    const { clientOrderId: _drop, ...noClient } = ORDER;
    const order = decodeOrder(JSON.stringify(noClient), { base: 8, quote: 8 });
    expect(order.clientOrderId).toBeNull();
  });

  it('reads an account-wide open-order array, including symbols outside the selected one', () => {
    // The account-wide scan exists to find exactly these (ADR-0002 condition C2).
    const body = JSON.stringify([ORDER, { ...ORDER, symbol: 'ETHUSDT', orderId: 7 }]);
    const orders = decodeOpenOrders(body);
    expect(orders.map((o) => o.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(orders.map((o) => o.venueOrderId)).toEqual(['100234', '7']);
  });

  it('refuses an open-order body that is not an array, never returning none', () => {
    // "No open orders" is the answer that lets a cut be declared clean.
    for (const body of ['{}', 'null', '"[]"', '']) {
      expect(() => decodeOpenOrders(body), JSON.stringify(body)).toThrow(ReadFailure);
    }
    expect(decodeOpenOrders('[]')).toEqual([]);
  });
});

describe('decodeTrades', () => {
  const TRADE = {
    symbol: 'BTCUSDT',
    id: 28_457,
    orderId: 100_234,
    orderListId: -1,
    price: '30000.00000000',
    qty: '0.00050000',
    quoteQty: '15.00000000',
    commission: '0.00001500',
    commissionAsset: 'BNB',
    time: 1_788_867_050_000,
    isBuyer: true,
    isMaker: false,
    isBestMatch: true,
  };

  // Every fee asset the fixture uses must have a declared scale: the decoder refuses an
  // undeclared one rather than guessing, which is the behaviour a later case pins.
  const SCALES = { base: 8, quote: 8, commission: { BNB: 8, USDT: 8 } };

  it('reads exact atoms and preserves the actual fee asset', () => {
    const [trade] = decodeTrades(JSON.stringify([TRADE]), SCALES);
    expect(trade).toMatchObject({
      symbol: 'BTCUSDT',
      venueTradeId: '28457',
      venueOrderId: '100234',
      baseAtoms: 50_000n,
      quoteAtoms: 1_500_000_000n,
      commissionAsset: 'BNB',
      isBuyer: true,
      isMaker: false,
      tradedAt: 1_788_867_050_000,
    });
  });

  it('scales the commission by its own asset, not by the base or quote scale', () => {
    // A BNB commission on a BTCUSDT trade is denominated in BNB. Using the base scale here is
    // exactly how a fee lands in the wrong asset's accounting, and the difference is visible
    // whenever the fee asset's scale differs from the pair's.
    const [eight] = decodeTrades(JSON.stringify([TRADE]), SCALES);
    expect(eight?.commissionAtoms).toBe(1_500n);

    // The same fee string, declared at a different scale, is a different number of atoms.
    // A decoder that reached for the base or quote scale would return the same value twice.
    const sixDecimals = JSON.stringify([{ ...TRADE, commission: '0.015000' }]);
    expect(decodeTrades(sixDecimals, SCALES)[0]?.commissionAtoms).toBe(1_500_000n);
    expect(
      decodeTrades(sixDecimals, { base: 8, quote: 8, commission: { BNB: 6 } })[0]?.commissionAtoms,
    ).toBe(15_000n);
  });

  it('refuses a commission in an asset whose scale was not supplied', () => {
    // Guessing a scale for an unknown fee asset invents a number.
    expect(() =>
      decodeTrades(JSON.stringify([{ ...TRADE, commissionAsset: 'MYSTERY' }]), {
        base: 8,
        quote: 8,
        commission: { BNB: 8 },
      }),
    ).toThrow(/MYSTERY/);
  });

  it('refuses a body that is not an array, never returning no trades', () => {
    // T-021: an empty trade list is what lets a reservation be released.
    for (const body of ['{}', 'null', '', '{"trades":[]}']) {
      expect(() => decodeTrades(body, SCALES), JSON.stringify(body)).toThrow(ReadFailure);
    }
    expect(decodeTrades('[]', SCALES)).toEqual([]);
  });

  it('refuses a trade with a non-safe integer id rather than corrupting the identity', () => {
    const huge = JSON.stringify([{ ...TRADE, id: Number.MAX_SAFE_INTEGER + 2 }]);
    expect(() => decodeTrades(huge, SCALES)).toThrow(/safe integer|identity/i);
  });

  it('refuses a trade missing its commission asset instead of defaulting one', () => {
    const { commissionAsset: _drop, ...noAsset } = TRADE;
    expect(() => decodeTrades(JSON.stringify([noAsset]), SCALES)).toThrow(ReadFailure);
  });
});
