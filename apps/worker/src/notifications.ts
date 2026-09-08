import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export interface WebhookEnvelope {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface WebhookRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

function signature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/** Sign the exact UTF-8 body. Retrying a delivery reuses its delivery id, never its event. */
export function buildWebhookRequest(
  envelope: WebhookEnvelope,
  secret: string,
  timestampSeconds: string,
): WebhookRequest {
  if (!/^[1-9][0-9]{0,15}$/.test(timestampSeconds)) {
    throw new TypeError('webhook timestamp must be epoch seconds');
  }
  const body = JSON.stringify(envelope);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-capitaldesk-delivery': envelope.deliveryId,
      'x-capitaldesk-timestamp': timestampSeconds,
      'x-capitaldesk-signature': `v1=${signature(secret, timestampSeconds, body)}`,
    },
  };
}

export function verifyWebhookRequest(
  request: WebhookRequest,
  secrets: readonly string[],
  nowEpochSeconds: bigint,
  toleranceSeconds = 300n,
): boolean {
  const timestamp = request.headers['x-capitaldesk-timestamp'];
  const supplied = request.headers['x-capitaldesk-signature'];
  const delivery = request.headers['x-capitaldesk-delivery'];
  if (timestamp === undefined || supplied === undefined || !/^[1-9][0-9]{0,15}$/.test(timestamp)) {
    return false;
  }
  try {
    const body = JSON.parse(request.body) as { deliveryId?: unknown };
    if (typeof body.deliveryId !== 'string' || body.deliveryId !== delivery) return false;
  } catch {
    return false;
  }
  const sentAt = BigInt(timestamp);
  const age = nowEpochSeconds >= sentAt ? nowEpochSeconds - sentAt : sentAt - nowEpochSeconds;
  if (age > toleranceSeconds) return false;
  return secrets.some((secret) => {
    const expected = `v1=${signature(secret, timestamp, request.body)}`;
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(supplied, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
  });
}

function blockedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  const [a, b] = octets;
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && octets[2] === 113)
  );
}

function blockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blockedIpv4(address);
  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.')
    );
  }
  return true;
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

/** Resolve every address and fail closed if any answer can reach a private/internal network. */
export async function validateWebhookDestination(
  destination: string,
  resolve: HostResolver,
): Promise<URL> {
  const url = new URL(destination);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443')
  ) {
    throw new TypeError('webhook destination must be credential-free HTTPS on port 443');
  }
  const addresses = isIP(url.hostname) === 0 ? await resolve(url.hostname) : [url.hostname];
  if (addresses.length === 0 || addresses.some(blockedIp)) {
    throw new TypeError('webhook destination resolves to a blocked network');
  }
  return url;
}

/** Deterministic capped backoff; economic outbox messages never use this helper. */
export function webhookBackoffMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('attempt must be positive');
  return Math.min(300_000, 1_000 * 2 ** Math.min(attempt - 1, 8));
}
