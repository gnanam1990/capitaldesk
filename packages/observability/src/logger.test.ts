import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger } from './logger.js';
import { REDACTED } from './redaction.js';

/**
 * These tests assert on what actually reaches the sink.
 *
 * Independent probing found that a logger which redacts only in `formatters.log` leaks
 * through the message string, printf interpolation, child bindings and the base bindings.
 * Asserting on the `redact()` helper would have passed throughout, which is why every
 * assertion here captures the serialized output instead.
 */

/** Secret-shaped material, assembled at runtime so no literal exists in the tree. */
const KEY = ['aB3dEfGh1jKlMnOpQrStUvWxYz234567', 'HgFeDcBa9876543210ZyXwVuTsRqPoNm'].join('');
const LOW_ENTROPY = 'hunter2-not-a-shape';

function capture(): { stream: DestinationStream; lines: () => string[]; text: () => string } {
  const written: string[] = [];
  return {
    stream: {
      write(line: string): void {
        written.push(line);
      },
    },
    lines: () => written,
    text: () => written.join(''),
  };
}

function loggerWith(sink: DestinationStream, accountAlias = 'capitaldesk-proof') {
  return createLogger({
    role: 'api',
    level: 'trace',
    buildId: 'test-build',
    deploymentEnvironment: 'local',
    accountAlias,
    destination: sink,
  });
}

describe('logger redaction at the sink', () => {
  it('redacts a secret embedded in the message string', () => {
    const sink = capture();
    loggerWith(sink.stream).info(`request failed for ${KEY}`);
    expect(sink.text()).not.toContain(KEY);
    expect(sink.text()).toContain(REDACTED);
  });

  it('redacts a secret passed as a printf interpolation argument', () => {
    const sink = capture();
    loggerWith(sink.stream).info('request failed for %s', KEY);
    expect(sink.text()).not.toContain(KEY);
  });

  it('redacts a secret in child bindings', () => {
    const sink = capture();
    loggerWith(sink.stream).child({ apiKey: KEY }).info('child binding');
    expect(sink.text()).not.toContain(KEY);
  });

  it('redacts a low-entropy secret under a revealing key in child bindings', () => {
    // Shape matching cannot catch this; key-name redaction must.
    const sink = capture();
    loggerWith(sink.stream).child({ password: LOW_ENTROPY }).info('child binding');
    expect(sink.text()).not.toContain(LOW_ENTROPY);
  });

  it('redacts a secret that arrives through the base bindings', () => {
    const sink = capture();
    loggerWith(sink.stream, KEY).info('base binding');
    expect(sink.text()).not.toContain(KEY);
  });

  it('redacts a secret in an object argument', () => {
    const sink = capture();
    loggerWith(sink.stream).info({ apiKey: KEY }, 'object field');
    expect(sink.text()).not.toContain(KEY);
  });

  it('redacts a secret inside a logged Error message', () => {
    const sink = capture();
    loggerWith(sink.stream).error({ err: new Error(`boom ${KEY}`) }, 'failed');
    expect(sink.text()).not.toContain(KEY);
  });

  it('redacts a secret in a nested object argument', () => {
    const sink = capture();
    loggerWith(sink.stream).info({ attempt: { headers: { 'x-mbx-apikey': KEY } } }, 'nested');
    expect(sink.text()).not.toContain(KEY);
  });

  it('redacts URL query aliases wherever they appear', () => {
    const sink = capture();
    loggerWith(sink.stream).info(
      `GET https://venue/api?symbol=BTCUSDT&access_token=SEK1&refreshToken=SEK2&client_secret=SEK3&api-key=SEK4`,
    );
    expect(sink.text()).not.toMatch(/SEK\d/);
    // Non-sensitive context must survive, or incidents stop being reproducible.
    expect(sink.text()).toContain('symbol=BTCUSDT');
  });

  it('holds at every level', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      const sink = capture();
      loggerWith(sink.stream)[level](`leak ${KEY}`);
      expect(sink.text(), level).not.toContain(KEY);
    }
  });

  it('holds through a grandchild logger', () => {
    const sink = capture();
    loggerWith(sink.stream).child({ planId: 'p1' }).child({ apiKey: KEY }).info('grandchild');
    expect(sink.text()).not.toContain(KEY);
  });

  describe('useful output survives redaction', () => {
    it('keeps correlation fields and the message', () => {
      const sink = capture();
      loggerWith(sink.stream).info({ planId: 'plan-7', symbol: 'BTCUSDT' }, 'sealed');
      const line = JSON.parse(sink.lines()[0]!) as Record<string, unknown>;
      expect(line['planId']).toBe('plan-7');
      expect(line['symbol']).toBe('BTCUSDT');
      expect(line['msg']).toBe('sealed');
      expect(line['role']).toBe('api');
      expect(line['buildId']).toBe('test-build');
    });

    it('keeps booleans and numbers intact rather than stringifying them', () => {
      const sink = capture();
      loggerWith(sink.stream).info({ writeCapability: false, epoch: 3 }, 'config');
      const line = JSON.parse(sink.lines()[0]!) as Record<string, unknown>;
      expect(line['writeCapability']).toBe(false);
      expect(line['epoch']).toBe(3);
    });

    it('keeps exact atom strings for quantities', () => {
      const sink = capture();
      loggerWith(sink.stream).info({ atoms: 39_800_000_000n }, 'quantity');
      const line = JSON.parse(sink.lines()[0]!) as Record<string, unknown>;
      expect(line['atoms']).toBe('39800000000');
    });

    it('still emits parseable JSON on every path', () => {
      const sink = capture();
      const log = loggerWith(sink.stream);
      log.info(`msg ${KEY}`);
      log.child({ apiKey: KEY }).info('child');
      log.error({ err: new Error(`boom ${KEY}`) }, 'err');
      for (const line of sink.lines()) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
