import { describe, expect, it, vi } from 'vitest';
import {
  FaultTransportRefused,
  TestnetResponseLossTransport,
  assertTestnetOrderTarget,
} from './testnet-proxy.js';

describe('testnet-only response loss transport', () => {
  it('refuses every live, local, credential-bearing and non-order target', () => {
    for (const target of [
      'https://api.binance.com/api/v3/order',
      'https://api1.binance.com/api/v3/order',
      'http://testnet.binance.vision/api/v3/order',
      'https://user:pass@testnet.binance.vision/api/v3/order',
      'https://testnet.binance.vision/api/v3/account',
      'http://127.0.0.1:3000/api/v3/order',
    ]) {
      expect(() => assertTestnetOrderTarget(target), target).toThrow(FaultTransportRefused);
    }
  });

  it('forwards one actual testnet request and drops the observed response without fabricating it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"orderId":123}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const transport = new TestnetResponseLossTransport();
    const outcome = await transport.forward(
      {
        target: 'https://testnet.binance.vision/api/v3/order',
        init: { method: 'POST', body: 'symbol=BTCUSDT' },
        dropResponse: true,
      },
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      kind: 'REAL_RESPONSE_DROPPED',
      status: '200',
      downstreamAttempts: '1',
    });
    expect(outcome).not.toHaveProperty('body');
    await expect(
      transport.forward(
        {
          target: 'https://testnet.binance.vision/api/v3/order',
          init: { method: 'POST' },
          dropResponse: false,
        },
        fetcher,
      ),
    ).rejects.toThrow(/cannot resend/);
  });

  it('refuses a non-POST before consuming the one-use transport', async () => {
    const transport = new TestnetResponseLossTransport();
    await expect(
      transport.forward(
        {
          target: 'https://testnet.binance.vision/api/v3/order',
          init: { method: 'GET' },
          dropResponse: true,
        },
        vi.fn<typeof fetch>(),
      ),
    ).rejects.toThrow(/only POST/);
  });
});
