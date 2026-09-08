import { describe, expect, it } from 'vitest';
import {
  buildWebhookRequest,
  validateWebhookDestination,
  verifyWebhookRequest,
  webhookBackoffMs,
} from './notifications.js';

const ENVELOPE = {
  deliveryId: 'delivery-1',
  eventId: '42',
  eventType: 'plan.approved',
  occurredAt: '2026-09-08T00:00:00.000Z',
  payload: { planId: 'plan-1', state: 'APPROVED' },
} as const;

describe('signed webhook boundary', () => {
  it('binds the exact body, delivery id and timestamp and accepts rotating secrets', () => {
    const request = buildWebhookRequest(ENVELOPE, 'new-secret', '1788825600');
    expect(verifyWebhookRequest(request, ['old-secret', 'new-secret'], 1788825601n)).toBe(true);
    expect(
      verifyWebhookRequest({ ...request, body: `${request.body} ` }, ['new-secret'], 1788825601n),
    ).toBe(false);
    expect(
      verifyWebhookRequest(
        { ...request, headers: { ...request.headers, 'x-capitaldesk-delivery': 'delivery-2' } },
        ['new-secret'],
        1788825601n,
      ),
    ).toBe(false);
    expect(JSON.parse(request.body)).toMatchObject({ deliveryId: 'delivery-1', eventId: '42' });
  });

  it('refuses replay outside the timestamp window', () => {
    const request = buildWebhookRequest(ENVELOPE, 'secret', '1788825600');
    expect(verifyWebhookRequest(request, ['secret'], 1788825900n)).toBe(true);
    expect(verifyWebhookRequest(request, ['secret'], 1788825901n)).toBe(false);
  });

  it('rejects private, loopback, credentialed and mixed DNS destinations', async () => {
    const publicOnly = () => Promise.resolve(['93.184.216.34']);
    await expect(
      validateWebhookDestination('http://hooks.example.test/x', publicOnly),
    ).rejects.toThrow(/HTTPS/);
    await expect(validateWebhookDestination('https://127.0.0.1/x', publicOnly)).rejects.toThrow(
      /blocked/,
    );
    await expect(
      validateWebhookDestination('https://user:pass@hooks.example.test/x', publicOnly),
    ).rejects.toThrow(/credential-free/);
    await expect(
      validateWebhookDestination('https://hooks.example.test/x', () =>
        Promise.resolve(['93.184.216.34', '10.0.0.1']),
      ),
    ).rejects.toThrow(/blocked/);
  });

  it('caps notification backoff without changing economic job semantics', () => {
    expect(webhookBackoffMs(1)).toBe(1_000);
    expect(webhookBackoffMs(20)).toBe(256_000);
  });
});
