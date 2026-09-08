import { describe, expect, it } from 'vitest';
import { redactText, redactUrl, safeHeaders } from './redaction.js';

/**
 * Nothing that leaves this package may carry credential material (T-044).
 *
 * A signed Binance read request puts the API key in a header and the HMAC in the query
 * string, so the URL and the headers are both secret-bearing by construction. Errors, logs
 * and evidence digests are all built from those, which is precisely how a key reaches a log.
 */
describe('redaction', () => {
  // Structured to read as a fixture, not as a plausible live key.
  const KEY = 'EXAMPLE-api-key-for-redaction-tests-do-not-use-0000000000000000';
  const SIGNATURE = 'EXAMPLE-hmac-signature-for-redaction-tests-000000000000000000000';

  describe('redactUrl', () => {
    it('removes the signature and every other credential-bearing parameter', () => {
      const url = new URL(
        `https://testnet.binance.vision/api/v3/myTrades?symbol=BTCUSDT&fromId=7&timestamp=1&signature=${SIGNATURE}`,
      );
      const redacted = redactUrl(url);
      expect(redacted).not.toContain(SIGNATURE);
      expect(redacted).toContain('signature=REDACTED');
      // The non-secret parameters survive, or the redaction destroys the diagnostic.
      expect(redacted).toContain('symbol=BTCUSDT');
      expect(redacted).toContain('fromId=7');
    });

    it('redacts a credential parameter whatever case the caller used', () => {
      const url = new URL(
        `https://testnet.binance.vision/api/v3/account?Signature=${SIGNATURE}&apiKey=${KEY}`,
      );
      const redacted = redactUrl(url);
      expect(redacted).not.toContain(SIGNATURE);
      expect(redacted).not.toContain(KEY);
    });

    it('drops userinfo, which is a credential the URL parser hides in plain sight', () => {
      // Assembled rather than written as a literal. A URL literal carrying userinfo is a
      // credential shape whatever its contents, and a secret scanner is right to flag one in a
      // committed file.
      const url = new URL('https://testnet.binance.vision/api/v3/time');
      url.username = 'fixture-user';
      url.password = 'fixture-not-a-secret';
      const redacted = redactUrl(url);
      expect(redacted).not.toContain('fixture-not-a-secret');
      expect(redacted).not.toContain('fixture-user');
      expect(redacted).toContain('testnet.binance.vision/api/v3/time');
    });

    it('keeps the host and path, so an incident is still reproducible', () => {
      const url = new URL('https://testnet.binance.vision/api/v3/order?symbol=BTCUSDT');
      expect(redactUrl(url)).toBe('https://testnet.binance.vision/api/v3/order?symbol=BTCUSDT');
    });
  });

  describe('safeHeaders', () => {
    it('keeps the diagnostic headers and drops everything else', () => {
      const kept = safeHeaders(
        new Headers({
          'X-MBX-APIKEY': KEY,
          'x-mbx-used-weight-1m': '20',
          'retry-after': '61',
          'x-mbx-uuid': 'e54e2b8c',
          authorization: `Bearer ${KEY}`,
          cookie: 'session=abc',
          'set-cookie': 'session=abc',
          'content-type': 'application/json',
        }),
      );
      expect(kept).toEqual({
        'content-type': 'application/json',
        'retry-after': '61',
        'x-mbx-used-weight-1m': '20',
        'x-mbx-uuid': 'e54e2b8c',
      });
    });

    it('is an allowlist, so an unrecognised header is dropped rather than kept', () => {
      // A denylist would leak the next header the venue invents.
      expect(safeHeaders(new Headers({ 'x-some-new-header': KEY }))).toEqual({});
    });
  });

  describe('redactText', () => {
    it('removes a known secret value wherever it appears', () => {
      const text = `request failed for key ${KEY} with signature ${SIGNATURE}`;
      const redacted = redactText(text, [KEY, SIGNATURE]);
      expect(redacted).not.toContain(KEY);
      expect(redacted).not.toContain(SIGNATURE);
      expect(redacted).toContain('REDACTED');
    });

    it('removes a signature or key that appears in a query string it was not told about', () => {
      const text = 'GET /api/v3/account?timestamp=1&signature=abcdef0123456789 failed';
      expect(redactText(text, [])).not.toContain('abcdef0123456789');
    });

    it('ignores an empty or whitespace secret rather than redacting the whole string', () => {
      // Replacing every empty match would turn any message into a wall of REDACTED.
      expect(redactText('plain message', ['', '   '])).toBe('plain message');
    });

    it('leaves text with nothing secret in it unchanged', () => {
      expect(redactText('symbol BTCUSDT is not trading', [KEY])).toBe(
        'symbol BTCUSDT is not trading',
      );
    });
  });
});
