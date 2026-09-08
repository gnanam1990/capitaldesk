import { createHash } from 'node:crypto';
import {
  assertApprovedVenueOrigin,
  assertEnvelopeWellFormed,
  assertTransmissionPermitted,
  violate,
  type DeploymentEnvironment,
  type SignedRequestEnvelope,
} from '@capitaldesk/contracts';

export interface LimitIocOrder {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: string;
  readonly price: string;
  readonly clientOrderId: string;
}

/** Opaque trade credential. Its key material never leaves the executor-owned implementation. */
export interface TradeCredential {
  readonly credentialClass: 'VENUE_TRADE';
  readonly alias: string;
  readonly stableAccountId: string;
  authorize(body: URLSearchParams): {
    readonly headers: Readonly<Record<string, string>>;
    readonly signedBody: URLSearchParams;
  };
}

export interface SignedOrderRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly envelope: SignedRequestEnvelope;
}

/** Refuse malformed journal payloads before either durable SEND_ATTEMPTED or the socket write. */
export function parseSignedOrderRequest(value: unknown): SignedOrderRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    violate('IDENTITY_MALFORMED', 'signed request journal payload must be an object');
  }
  const candidate = value as Partial<SignedOrderRequest>;
  if (
    candidate.method !== 'POST' ||
    typeof candidate.url !== 'string' ||
    candidate.headers === null ||
    typeof candidate.headers !== 'object' ||
    Array.isArray(candidate.headers) ||
    typeof candidate.body !== 'string' ||
    candidate.envelope === null ||
    typeof candidate.envelope !== 'object' ||
    Array.isArray(candidate.envelope)
  ) {
    violate('IDENTITY_MALFORMED', 'signed request journal payload is malformed');
  }
  for (const [name, headerValue] of Object.entries(candidate.headers)) {
    if (name.length === 0 || typeof headerValue !== 'string') {
      violate('IDENTITY_MALFORMED', 'signed request headers must contain string values');
    }
  }
  assertEnvelopeWellFormed(candidate.envelope);
  return candidate as SignedOrderRequest;
}

export type TradeResult =
  | { readonly kind: 'ACKNOWLEDGED'; readonly status: number; readonly safeBody: string }
  | { readonly kind: 'REJECTED'; readonly status: number; readonly safeBody: string }
  | { readonly kind: 'UNKNOWN'; readonly status: number | null; readonly reason: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SYMBOL = /^[A-Z0-9]{2,32}$/;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function validateOrder(order: LimitIocOrder): void {
  if (!SYMBOL.test(order.symbol) || !ID.test(order.clientOrderId)) {
    violate('IDENTITY_MALFORMED', 'order symbol or client identity is malformed');
  }
  if (
    !DECIMAL.test(order.quantity) ||
    order.quantity === '0' ||
    !DECIMAL.test(order.price) ||
    order.price === '0'
  ) {
    violate(
      'MONEY_NOT_AN_INTEGER',
      'LIMIT IOC quantity and price must be positive canonical decimals',
    );
  }
}

/** The only signer: fixed POST /api/v3/order with LIMIT IOC fields and no retry surface. */
export class BinanceLimitIocSigner {
  readonly #origin: string;
  readonly #credential: TradeCredential;

  constructor(options: {
    readonly deployment: DeploymentEnvironment;
    readonly origin: string;
    readonly credential: TradeCredential;
  }) {
    if (options.credential.credentialClass !== 'VENUE_TRADE') {
      violate('AUTHZ_CREDENTIAL_CLASS_DENIED', 'trade signer accepts only VENUE_TRADE');
    }
    assertApprovedVenueOrigin(options.deployment, options.origin);
    this.#origin = options.origin.replace(/\/$/, '');
    this.#credential = options.credential;
  }

  sign(input: {
    readonly order: LimitIocOrder;
    readonly signedTimestampMs: number;
    readonly venueClockOffsetMs: number;
    readonly validityMs: number;
    readonly clockSkewBudgetMs: number;
    readonly transmissionLatencyBudgetMs: number;
  }): SignedOrderRequest {
    validateOrder(input.order);
    const body = new URLSearchParams({
      symbol: input.order.symbol,
      side: input.order.side,
      type: 'LIMIT',
      timeInForce: 'IOC',
      quantity: input.order.quantity,
      price: input.order.price,
      newClientOrderId: input.order.clientOrderId,
      timestamp: String(input.signedTimestampMs),
      recvWindow: String(input.validityMs),
    });
    const authorized = this.#credential.authorize(body);
    const frozenBody = authorized.signedBody.toString();
    const envelope: SignedRequestEnvelope = {
      signedTimestampMs: input.signedTimestampMs,
      venueClockOffsetMs: input.venueClockOffsetMs,
      validityMs: input.validityMs,
      clockSkewBudgetMs: input.clockSkewBudgetMs,
      transmissionLatencyBudgetMs: input.transmissionLatencyBudgetMs,
      signedPayloadDigest: `sha256:${createHash('sha256').update(frozenBody).digest('hex')}`,
    };
    assertEnvelopeWellFormed(envelope);
    return Object.freeze({
      method: 'POST',
      url: `${this.#origin}/api/v3/order`,
      headers: Object.freeze({ ...authorized.headers }),
      body: frozenBody,
      envelope: Object.freeze(envelope),
    });
  }
}

function safeBody(text: string): string {
  return text
    .replace(/("?(?:signature|token|secret|apiKey)"?\s*[:=]\s*)[^,&}\s]+/gi, '$1[REDACTED]')
    .slice(0, 4096);
}

/** A credential-free, signer-free sender. It invokes fetch exactly once after the durable hook. */
export class OneShotTradeTransmitter {
  constructor(
    private readonly options: {
      readonly deployment: DeploymentEnvironment;
      readonly origin: string;
      readonly fetch: typeof fetch;
      readonly nowMs: () => number;
    },
  ) {
    assertApprovedVenueOrigin(options.deployment, options.origin);
  }

  async send(
    rawRequest: SignedOrderRequest,
    recordSendAttempted: () => Promise<boolean>,
  ): Promise<TradeResult> {
    const request = parseSignedOrderRequest(rawRequest);
    const expected = `${this.options.origin.replace(/\/$/, '')}/api/v3/order`;
    if (request.method !== 'POST' || request.url !== expected) {
      violate(
        'UNSUPPORTED_ACTION',
        'transmitter accepts only the fixed Binance LIMIT IOC endpoint',
      );
    }
    assertTransmissionPermitted(request.envelope, this.options.nowMs());
    if (!(await recordSendAttempted())) {
      return { kind: 'UNKNOWN', status: null, reason: 'durable SEND_ATTEMPTED write was refused' };
    }
    let response: Response;
    try {
      response = await this.options.fetch(
        new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          redirect: 'error',
        }),
      );
    } catch {
      return { kind: 'UNKNOWN', status: null, reason: 'transport failed after SEND_ATTEMPTED' };
    }
    let body: string;
    try {
      body = safeBody(await response.text());
    } catch {
      return { kind: 'UNKNOWN', status: response.status, reason: 'response body unavailable' };
    }
    if (response.status >= 200 && response.status < 300) {
      return { kind: 'ACKNOWLEDGED', status: response.status, safeBody: body };
    }
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 418 &&
      response.status !== 429
    ) {
      return { kind: 'REJECTED', status: response.status, safeBody: body };
    }
    return {
      kind: 'UNKNOWN',
      status: response.status,
      reason: `ambiguous HTTP ${String(response.status)}`,
    };
  }
}
