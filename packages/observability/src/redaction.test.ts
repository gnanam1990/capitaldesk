import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactText } from './redaction.js';

/**
 * Representative secret-shaped material. These are invented strings of the right shape,
 * never real credentials (TEST-PLAN T-044).
 */
const KEY_SHAPED = 'aB3dEfGh1jKlMnOpQrStUvWxYz234567aB3dEfGh1jKlMnOpQrStUvWxYz234567';

describe('redaction', () => {
  it('removes values under sensitive key names', () => {
    const output = redact({
      apiKey: KEY_SHAPED,
      api_secret: 'anything',
      Authorization: 'Bearer abc.def',
      cookie: 'session=1',
      signature: 'deadbeef',
      symbol: 'BTCUSDT',
    }) as Record<string, string>;

    expect(output['apiKey']).toBe(REDACTED);
    expect(output['api_secret']).toBe(REDACTED);
    expect(output['Authorization']).toBe(REDACTED);
    expect(output['cookie']).toBe(REDACTED);
    expect(output['signature']).toBe(REDACTED);
    // Non-sensitive operational context must survive, or incidents become unreproducible.
    expect(output['symbol']).toBe('BTCUSDT');
  });

  it('removes key-shaped values even under an innocent key name', () => {
    const output = redact({ note: `the key is ${KEY_SHAPED}` }) as Record<string, string>;
    expect(output['note']).not.toContain(KEY_SHAPED);
    expect(output['note']).toContain(REDACTED);
  });

  it('strips signed query parameters from a URL', () => {
    const text = redactText(
      `https://testnet.binance.vision/api/v3/order?symbol=BTCUSDT&signature=${KEY_SHAPED}`,
    );
    expect(text).not.toContain(KEY_SHAPED);
    expect(text).toContain('symbol=BTCUSDT');
  });

  it('redacts inside errors while keeping the correlation trail', () => {
    const error = new Error(`request failed for key ${KEY_SHAPED}`);
    const output = redact(error) as { name: string; message: string };
    expect(output.name).toBe('Error');
    expect(output.message).not.toContain(KEY_SHAPED);
  });

  it('redacts through nested structures and arrays', () => {
    const output = redact({
      attempt: { headers: [{ 'x-mbx-apikey': KEY_SHAPED }], planId: 'plan-7' },
    }) as { attempt: { headers: Array<Record<string, string>>; planId: string } };
    expect(output.attempt.headers[0]!['x-mbx-apikey']).toBe(REDACTED);
    expect(output.attempt.planId).toBe('plan-7');
  });

  it('serialises bigint quantities as exact strings rather than dropping them', () => {
    const output = redact({ atoms: 39_800_000_000n }) as Record<string, string>;
    expect(output['atoms']).toBe('39800000000');
  });

  it('bounds recursion depth instead of following a deep structure forever', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain('depth-limited');
  });

  it('leaves a Bearer token unusable', () => {
    expect(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload')).toContain(REDACTED);
  });
});
