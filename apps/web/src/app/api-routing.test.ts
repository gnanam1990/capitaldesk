import { describe, expect, it } from 'vitest';
import { API_PREFIX, ApiRoutingError, apiRewrites } from './api-routing.js';

describe('same-origin API routing', () => {
  it('proxies the API prefix to the configured origin', () => {
    expect(apiRewrites('http://127.0.0.1:3000')).toEqual([
      { source: '/api/:path*', destination: 'http://127.0.0.1:3000/:path*' },
    ]);
  });

  it('does not produce a double slash when the base URL ends in one', () => {
    // The same defect as the health URL: `//v1/...` is a different path, and the API answers
    // it with a 404 that looks like a missing route rather than a misconfigured proxy.
    const [rewrite] = apiRewrites('https://api.example/');
    expect(rewrite?.destination).toBe('https://api.example/:path*');
  });

  it('keeps a base path prefix when the API is mounted under one', () => {
    const [rewrite] = apiRewrites('https://gateway.example/capitaldesk/');
    expect(rewrite?.destination).toBe('https://gateway.example/capitaldesk/:path*');
  });

  it('refuses a base URL that is not an http origin', () => {
    for (const invalid of ['not-a-url', 'file:///etc/hosts', 'ftp://example.test']) {
      expect(() => apiRewrites(invalid)).toThrow(ApiRoutingError);
    }
  });

  it('refuses a base URL carrying a query or fragment', () => {
    expect(() => apiRewrites('http://api.test/?token=abc')).toThrow(ApiRoutingError);
    expect(() => apiRewrites('http://api.test/#frag')).toThrow(ApiRoutingError);
  });

  it('routes under a prefix the console can call relatively', () => {
    // Browser code must use this prefix rather than the configured base URL, or the strict
    // session cookie is dropped as cross-site.
    expect(API_PREFIX.startsWith('/')).toBe(true);
    expect(apiRewrites('http://127.0.0.1:3000')[0]?.source.startsWith(API_PREFIX)).toBe(true);
  });
});
