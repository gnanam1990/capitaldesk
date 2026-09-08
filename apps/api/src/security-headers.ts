import type { FastifyReply } from 'fastify';

export const API_BODY_LIMIT_BYTES = 65_536;

export function securityHeaders(secureTransport: boolean): Readonly<Record<string, string>> {
  return {
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...(secureTransport
      ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
      : {}),
  };
}

export function applySecurityHeaders(reply: FastifyReply, secureTransport: boolean): void {
  for (const [name, value] of Object.entries(securityHeaders(secureTransport))) {
    void reply.header(name, value);
  }
}
