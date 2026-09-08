import { describe, expect, it } from 'vitest';
import { ContractViolation } from '@capitaldesk/contracts';
import {
  READ_ENDPOINTS,
  buildReadUrl,
  isNamedRead,
  isReadableUrl,
  readOrigin,
  requestWeight,
  type ReadEndpointName,
} from './endpoints.js';

/**
 * The endpoint table is evidence, not convenience.
 *
 * Every number here was read from the official Spot REST document at the revision recorded in
 * docs/evidence/binance-read-capability.md, and the shapes were confirmed against a real
 * public read of testnet.binance.vision. A weight guessed from memory is how a client walks
 * into an IP ban, and a path assembled by string concatenation is how a read-only client
 * acquires a write.
 */
const TESTNET = readOrigin('https://testnet.binance.vision');

describe('the verified read endpoint table', () => {
  it('carries only GET endpoints under /api/v3', () => {
    for (const [name, endpoint] of Object.entries(READ_ENDPOINTS)) {
      expect(endpoint.method, name).toBe('GET');
      expect(endpoint.path, name).toMatch(/^\/api\/v3\/[a-zA-Z]+$/);
    }
  });

  it('states the documented weights, including the conditional ones', () => {
    expect(requestWeight('exchangeInfo', {})).toBe(20);
    expect(requestWeight('account', {})).toBe(20);
    expect(requestWeight('order', {})).toBe(4);
    // openOrders: 6 for a single symbol; 80 when the symbol parameter is omitted.
    expect(requestWeight('openOrders', { symbol: 'BTCUSDT' })).toBe(6);
    expect(requestWeight('openOrders', {})).toBe(80);
    // myTrades: 20 without orderId, 5 with.
    expect(requestWeight('myTrades', { symbol: 'BTCUSDT' })).toBe(20);
    expect(requestWeight('myTrades', { symbol: 'BTCUSDT', orderId: '5' })).toBe(5);
  });

  it('never gives an absent parameter the cheaper conditional weight', () => {
    // An empty string is not a symbol and null is not an order id. Charging the caller 6 for
    // a request the venue charges 80 for is discovered as a 429 and then an IP ban.
    for (const symbol of ['', '   ', null, undefined, Number.NaN]) {
      expect(requestWeight('openOrders', { symbol }), JSON.stringify(symbol)).toBe(80);
    }
    for (const orderId of ['', '  ', null, undefined, Number.NaN]) {
      expect(
        requestWeight('myTrades', { symbol: 'BTCUSDT', orderId }),
        JSON.stringify(orderId),
      ).toBe(20);
    }
    // And a genuinely present value still gets the cheap branch, including a numeric zero.
    expect(requestWeight('myTrades', { symbol: 'BTCUSDT', orderId: 0 })).toBe(5);
    expect(requestWeight('myTrades', { symbol: 'BTCUSDT', orderId: 7n })).toBe(5);
  });

  it('records which endpoints are authenticated, and which are public', () => {
    expect(READ_ENDPOINTS.exchangeInfo.security).toBe('NONE');
    expect(READ_ENDPOINTS.serverTime.security).toBe('NONE');
    for (const name of ['account', 'order', 'openOrders', 'myTrades'] as const) {
      expect(READ_ENDPOINTS[name].security, name).toBe('USER_DATA');
    }
  });

  it('names the mandatory parameters the venue documents', () => {
    expect(READ_ENDPOINTS.order.mandatory).toEqual(['symbol', 'timestamp']);
    expect(READ_ENDPOINTS.myTrades.mandatory).toEqual(['symbol', 'timestamp']);
    expect(READ_ENDPOINTS.openOrders.mandatory).toEqual(['timestamp']);
    expect(READ_ENDPOINTS.exchangeInfo.mandatory).toEqual([]);
  });

  it('records the myTrades range and page bounds the venue documents', () => {
    expect(READ_ENDPOINTS.myTrades.maxRangeMs).toBe(24 * 60 * 60 * 1000);
    expect(READ_ENDPOINTS.myTrades.maxLimit).toBe(1000);
  });

  it('exposes every endpoint name in the exported type', () => {
    const names: ReadEndpointName[] = Object.keys(READ_ENDPOINTS) as ReadEndpointName[];
    expect(names).toEqual([
      'serverTime',
      'exchangeInfo',
      'account',
      'order',
      'openOrders',
      'myTrades',
    ]);
  });
});

describe('readOrigin', () => {
  it('accepts the exact approved testnet origin', () => {
    expect(TESTNET).toEqual({
      origin: 'https://testnet.binance.vision',
      protocol: 'https:',
      hostname: 'testnet.binance.vision',
      port: '443',
    });
  });

  it('accepts the loopback host the local deployment uses, with its explicit port', () => {
    expect(readOrigin('http://127.0.0.1:9443')).toEqual({
      origin: 'http://127.0.0.1:9443',
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: '9443',
    });
  });

  it('refuses plain http anywhere but a loopback address', () => {
    // A signed read carries the API key in a header and the HMAC in the query string.
    expect(() => readOrigin('http://testnet.binance.vision')).toThrow(ContractViolation);
    expect(() => readOrigin('http://attacker.invalid')).toThrow(/plain http/);
  });

  it('refuses a scheme that is not http or https', () => {
    for (const url of ['ftp://testnet.binance.vision', 'file:///etc/passwd', 'ws://host']) {
      expect(() => readOrigin(url), url).toThrow(ContractViolation);
    }
  });

  it('refuses userinfo, which is a credential the URL parser hides in plain sight', () => {
    // Assembled rather than written as a literal. A URL literal carrying userinfo is a
    // credential shape whatever its contents.
    const withUserinfo = new URL('https://testnet.binance.vision');
    withUserinfo.username = 'fixture-user';
    withUserinfo.password = 'fixture-not-a-secret';
    expect(() => readOrigin(withUserinfo.toString())).toThrow(/userinfo/);
  });

  it('refuses anything carrying a path, query or fragment', () => {
    for (const url of [
      'https://testnet.binance.vision/api',
      'https://testnet.binance.vision/?a=1',
      'https://testnet.binance.vision/#frag',
    ]) {
      expect(() => readOrigin(url), url).toThrow(/origin with no path/);
    }
  });

  it('refuses a string that is not a URL at all', () => {
    expect(() => readOrigin('testnet.binance.vision')).toThrow(ContractViolation);
    expect(() => readOrigin('')).toThrow(ContractViolation);
  });
});

describe('buildReadUrl', () => {
  it('builds the named endpoint against the approved origin', () => {
    expect(buildReadUrl(TESTNET, 'myTrades', { symbol: 'BTCUSDT', fromId: '7' }).toString()).toBe(
      'https://testnet.binance.vision/api/v3/myTrades?symbol=BTCUSDT&fromId=7',
    );
  });

  it('encodes parameter values rather than concatenating them into the path', () => {
    const url = buildReadUrl(TESTNET, 'order', { symbol: '../../evil?x=1&signature=leak' });
    expect(url.pathname).toBe('/api/v3/order');
    expect(url.origin).toBe(TESTNET.origin);
    // The whole hostile value landed in one parameter, escaped.
    expect(url.searchParams.get('symbol')).toBe('../../evil?x=1&signature=leak');
    expect(url.searchParams.get('signature')).toBeNull();
  });

  it('produces a URL that its own named check accepts', () => {
    for (const name of Object.keys(READ_ENDPOINTS) as ReadEndpointName[]) {
      const url = buildReadUrl(TESTNET, name);
      expect(isNamedRead(TESTNET, name, 'GET', url), name).toBe(true);
    }
  });
});

/**
 * The origin check is the write barrier and the credential barrier at once.
 *
 * An earlier version compared only the method and the pathname, so
 * `https://attacker.invalid/api/v3/account` passed. A USER_DATA read carries the API key in a
 * header and an HMAC in the query string, so a request accepted for a hostile origin hands
 * both to whoever answers it.
 */
describe('the origin-bound request check', () => {
  const base = 'https://testnet.binance.vision';

  it('admits exactly the tabled reads on the approved origin', () => {
    for (const endpoint of Object.values(READ_ENDPOINTS)) {
      expect(isReadableUrl(TESTNET, 'GET', new URL(base + endpoint.path)), endpoint.path).toBe(
        true,
      );
    }
  });

  it('refuses every other origin, however the path is spelled', () => {
    const hostile = [
      'https://attacker.invalid',
      'https://testnet.binance.vision.attacker.invalid',
      'https://binance.vision',
      'https://api.binance.com',
      'https://testnet.binance.vision.',
      // A registrable punycode lookalike, not a malformed label.
      'https://xn--binnce-6va.vision',
      'https://testnet-binance.vision',
      'https://evil.testnet.binance.vision',
      'http://testnet.binance.vision',
      'https://testnet.binance.vision:8443',
      'https://127.0.0.1',
    ];
    for (const origin of hostile) {
      for (const endpoint of Object.values(READ_ENDPOINTS)) {
        expect(
          isReadableUrl(TESTNET, 'GET', new URL(origin + endpoint.path)),
          `${origin}${endpoint.path}`,
        ).toBe(false);
      }
    }
  });

  it('refuses a URL carrying userinfo even on the approved host', () => {
    // URL#origin ignores userinfo, so comparing origins alone would accept this.
    const url = new URL(`${base}/api/v3/account`);
    url.username = 'fixture-user';
    url.password = 'fixture-not-a-secret';
    expect(url.origin).toBe(TESTNET.origin);
    expect(isReadableUrl(TESTNET, 'GET', url)).toBe(false);
  });

  it('refuses a URL carrying a fragment even on the approved host', () => {
    expect(isReadableUrl(TESTNET, 'GET', new URL(`${base}/api/v3/account#x`))).toBe(false);
  });

  it('refuses every write endpoint, on any method', () => {
    const writes = [
      '/api/v3/order',
      '/api/v3/order/test',
      '/api/v3/order/cancelReplace',
      '/api/v3/openOrders',
      '/api/v3/orderList',
      '/api/v3/userDataStream',
      '/sapi/v1/capital/withdraw/apply',
    ];
    for (const path of writes) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
        expect(isReadableUrl(TESTNET, method, new URL(base + path)), `${method} ${path}`).toBe(
          false,
        );
      }
    }
  });

  it('refuses a read path that is not in the table, however plausible', () => {
    for (const path of [
      '/api/v3/allOrders',
      '/api/v3/depth',
      '/sapi/v1/account/apiRestrictions',
      '/api/v3/account/commission',
    ]) {
      expect(isReadableUrl(TESTNET, 'GET', new URL(base + path)), path).toBe(false);
    }
  });

  it('is not fooled by a path that merely starts with an allowed one', () => {
    for (const path of ['/api/v3/accountEvil', '/api/v3/account/extra', '//api/v3/account']) {
      expect(isReadableUrl(TESTNET, 'GET', new URL(base + path)), path).toBe(false);
    }
  });

  it('refuses a lowercase or mixed-case method rather than normalising it', () => {
    for (const method of ['get', 'Get', 'gEt']) {
      expect(isReadableUrl(TESTNET, method, new URL(`${base}/api/v3/account`)), method).toBe(false);
    }
  });

  it('refuses a traversal that changes which endpoint was named', () => {
    // Authorised as `account`; resolves to `order`. It may be a tabled read, but it is no
    // longer the request the caller named, so the named check refuses it.
    const url = new URL(`${base}/api/v3/account/../order`);
    expect(url.pathname).toBe('/api/v3/order');
    expect(isNamedRead(TESTNET, 'account', 'GET', url)).toBe(false);
    expect(isNamedRead(TESTNET, 'order', 'GET', url)).toBe(true);
    expect(isNamedRead(TESTNET, 'order', 'POST', url)).toBe(false);
    expect(
      isReadableUrl(TESTNET, 'GET', new URL(`${base}/api/v3/account/../../v3/allOrders`)),
    ).toBe(false);
  });
});
