import { describe, expect, it } from 'vitest';
import { API_BODY_LIMIT_BYTES, securityHeaders } from './security-headers.js';

describe('API transport security policy', () => {
  it('sets deny-by-default browser capabilities and caching on every response', () => {
    const headers = securityHeaders(false);
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['permissions-policy']).toContain('payment=()');
  });

  it('enables HSTS only where the deployment contract requires HTTPS', () => {
    expect(securityHeaders(false)).not.toHaveProperty('strict-transport-security');
    expect(securityHeaders(true)['strict-transport-security']).toContain('includeSubDomains');
  });

  it('bounds request bodies before application parsing', () => {
    expect(API_BODY_LIMIT_BYTES).toBe(64 * 1024);
  });
});
