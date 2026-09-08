import { describe, expect, it, vi } from 'vitest';
import { DispatchConsumer } from './dispatch-consumer.js';
import { OneShotTradeTransmitter, type SignedOrderRequest } from './binance-write.js';

function request(): SignedOrderRequest {
  return {
    method: 'POST',
    url: 'http://127.0.0.1:9443/api/v3/order',
    headers: { 'x-api-key': 'redacted-test-key' },
    body: 'symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=IOC',
    envelope: {
      signedTimestampMs: 2_000,
      venueClockOffsetMs: 0,
      validityMs: 1_000,
      clockSkewBudgetMs: 100,
      transmissionLatencyBudgetMs: 100,
      signedPayloadDigest: 'sha256:test',
    },
  };
}

function fixture(options: { readonly status?: number; readonly payload?: unknown } = {}) {
  const calls: string[] = [];
  const journal = {
    attempt: vi.fn(() =>
      Promise.resolve({
        state: 'DISPATCH_MARKED' as const,
        clientOrderId: 'cd-1',
        markedAt: new Date(0),
        sendAttemptedAt: null,
        signedRequest: options.payload ?? request(),
      }),
    ),
    recordSendAttempted: vi.fn(() => {
      calls.push('SEND_ATTEMPTED');
      return Promise.resolve({ ok: true as const });
    }),
    resolve: vi.fn((input: { readonly to: string }) => {
      calls.push(input.to);
      return Promise.resolve({ ok: true as const });
    }),
  };
  const outbox = {
    claim: vi.fn(() =>
      Promise.resolve({
        outboxId: 'outbox-1',
        kind: 'dispatch.send',
        payload: { attemptId: 'attempt-1' },
        attempt: 1,
      }),
    ),
    acknowledge: vi.fn(() => {
      calls.push('ACK_OUTBOX');
      return Promise.resolve({ ok: true as const });
    }),
    fail: vi.fn(() => Promise.resolve({ kind: 'dead-lettered' })),
  };
  const fetchMock = vi.fn(() => {
    calls.push('FETCH');
    return Promise.resolve(new Response('{}', { status: options.status ?? 200 }));
  });
  const transmitter = new OneShotTradeTransmitter({
    deployment: 'local',
    origin: 'http://127.0.0.1:9443',
    fetch: fetchMock,
    nowMs: () => 2_500,
  });
  return { calls, journal, outbox, fetchMock, transmitter };
}

describe('single-attempt dispatch consumer', () => {
  it('journals the send before the only network call and resolves before acknowledging', async () => {
    const f = fixture();
    const result = await new DispatchConsumer(
      f.journal,
      f.outbox,
      f.transmitter,
      'executor-1',
      5_000,
    ).runOne({ workspaceId: 'w1', poolId: 'p1' });

    expect(result).toMatchObject({ kind: 'PROCESSED', attemptId: 'attempt-1' });
    expect(f.calls).toEqual(['SEND_ATTEMPTED', 'FETCH', 'ACKNOWLEDGED', 'ACK_OUTBOX']);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records ambiguous venue responses as UNKNOWN and never retries', async () => {
    const f = fixture({ status: 503 });
    const result = await new DispatchConsumer(
      f.journal,
      f.outbox,
      f.transmitter,
      'executor-1',
      5_000,
    ).runOne({ workspaceId: 'w1', poolId: 'p1' });

    expect(result).toMatchObject({ kind: 'PROCESSED', result: { kind: 'UNKNOWN' } });
    expect(f.calls).toEqual(['SEND_ATTEMPTED', 'FETCH', 'UNKNOWN', 'ACK_OUTBOX']);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dead-letters malformed signed bytes without recording or transmitting', async () => {
    const f = fixture({ payload: { method: 'GET' } });
    const result = await new DispatchConsumer(
      f.journal,
      f.outbox,
      f.transmitter,
      'executor-1',
      5_000,
    ).runOne({ workspaceId: 'w1', poolId: 'p1' });

    expect(result).toMatchObject({ kind: 'NEEDS_ATTENTION' });
    expect(f.journal.recordSendAttempted).not.toHaveBeenCalled();
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.outbox.fail).toHaveBeenCalledOnce();
  });
});
