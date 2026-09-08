import { describe, expect, it, vi } from 'vitest';
import {
  BinanceLimitIocSigner,
  OneShotTradeTransmitter,
  type TradeCredential,
} from './binance-write.js';

const credential: TradeCredential = {
  credentialClass: 'VENUE_TRADE',
  alias: 'test-trade',
  stableAccountId: 'account-1',
  authorize(body) {
    const signedBody = new URLSearchParams(body);
    signedBody.set('signature', 'secret-signature');
    return { headers: { 'x-mbx-apikey': 'secret-key' }, signedBody };
  },
};

function signed() {
  return new BinanceLimitIocSigner({
    deployment: 'local',
    origin: 'http://127.0.0.1:9443',
    credential,
  }).sign({
    order: {
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: '0.01',
      price: '20000',
      clientOrderId: 'child-1',
    },
    signedTimestampMs: 2_000,
    venueClockOffsetMs: 0,
    validityMs: 5_000,
    clockSkewBudgetMs: 100,
    transmissionLatencyBudgetMs: 100,
  });
}

describe('isolated LIMIT IOC write boundary', () => {
  it('can express only the fixed write method, path, type and time-in-force', () => {
    const request = signed();
    expect(request).toMatchObject({ method: 'POST', url: 'http://127.0.0.1:9443/api/v3/order' });
    expect(new URLSearchParams(request.body).get('type')).toBe('LIMIT');
    expect(new URLSearchParams(request.body).get('timeInForce')).toBe('IOC');
  });

  it('records SEND_ATTEMPTED before the sole physical fetch', async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(() => {
      order.push('fetch');
      return Promise.resolve(new Response('{"orderId":1}', { status: 200 }));
    });
    const result = await new OneShotTradeTransmitter({
      deployment: 'local',
      origin: 'http://127.0.0.1:9443',
      fetch: fetchMock,
      nowMs: () => 2_500,
    }).send(signed(), () => {
      order.push('marker');
      return Promise.resolve(true);
    });
    expect(order).toEqual(['marker', 'fetch']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('ACKNOWLEDGED');
  });

  it('does not send when the durable pre-byte write is refused', async () => {
    const fetchMock = vi.fn();
    const result = await new OneShotTradeTransmitter({
      deployment: 'local',
      origin: 'http://127.0.0.1:9443',
      fetch: fetchMock,
      nowMs: () => 2_500,
    }).send(signed(), () => Promise.resolve(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.kind).toBe('UNKNOWN');
  });

  it('classifies transport loss and retry-like HTTP statuses as UNKNOWN without a retry', async () => {
    for (const implementation of [
      () => Promise.reject(new Error('timeout')),
      () => Promise.resolve(new Response('slow', { status: 429 })),
      () => Promise.resolve(new Response('broken', { status: 503 })),
    ]) {
      const fetchMock = vi.fn(implementation);
      const result = await new OneShotTradeTransmitter({
        deployment: 'local',
        origin: 'http://127.0.0.1:9443',
        fetch: fetchMock,
        nowMs: () => 2_500,
      }).send(signed(), () => Promise.resolve(true));
      expect(result.kind).toBe('UNKNOWN');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects arbitrary write URLs before the durable marker hook', async () => {
    const hook = vi.fn(() => Promise.resolve(true));
    const request = { ...signed(), url: 'http://127.0.0.1:9443/api/v3/withdraw' };
    const transmitter = new OneShotTradeTransmitter({
      deployment: 'local',
      origin: 'http://127.0.0.1:9443',
      fetch,
      nowMs: () => 2_500,
    });
    await expect(transmitter.send(request, hook)).rejects.toThrow(
      /fixed Binance LIMIT IOC endpoint/,
    );
    expect(hook).not.toHaveBeenCalled();
  });
});
