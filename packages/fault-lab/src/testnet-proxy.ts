import { createHash } from 'node:crypto';

const TESTNET_ORIGIN = 'https://testnet.binance.vision';
const ALLOWED_PATHS = new Set(['/api/v3/order', '/api/v3/order/test']);

export class FaultTransportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaultTransportRefused';
  }
}

export function assertTestnetOrderTarget(target: string): URL {
  const url = new URL(target);
  if (url.origin !== TESTNET_ORIGIN) {
    throw new FaultTransportRefused(`fault transport accepts only ${TESTNET_ORIGIN}`);
  }
  if (!ALLOWED_PATHS.has(url.pathname)) {
    throw new FaultTransportRefused('fault transport accepts only the Spot order endpoints');
  }
  if (url.username !== '' || url.password !== '') {
    throw new FaultTransportRefused('credentials are forbidden in the target URL');
  }
  return url;
}

export type FaultForwardOutcome =
  | {
      readonly kind: 'RESPONSE_DELIVERED';
      readonly status: string;
      readonly bodyDigest: string;
      readonly downstreamAttempts: string;
    }
  | {
      readonly kind: 'REAL_RESPONSE_DROPPED';
      readonly status: string;
      readonly bodyDigest: string;
      readonly downstreamAttempts: string;
    }
  | {
      readonly kind: 'TRANSPORT_ERROR';
      readonly errorName: string;
      readonly downstreamAttempts: string;
    };

/**
 * One-use testnet transport seam. It forwards one actual request and may withhold that actual
 * response from its caller. It never invents a response body, fill or order id; only a digest
 * of the observed bytes leaves this boundary.
 */
export class TestnetResponseLossTransport {
  #used = false;

  async forward(
    request: {
      readonly target: string;
      readonly init: RequestInit;
      readonly dropResponse: boolean;
    },
    fetcher: typeof fetch = fetch,
  ): Promise<FaultForwardOutcome> {
    if (this.#used) throw new FaultTransportRefused('one-use fault transport cannot resend');
    const target = assertTestnetOrderTarget(request.target);
    if (request.init.method !== 'POST') {
      throw new FaultTransportRefused('fault transport forwards only POST order requests');
    }
    this.#used = true;
    try {
      const response = await fetcher(target, { ...request.init, redirect: 'error' });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const bodyDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      return {
        kind: request.dropResponse ? 'REAL_RESPONSE_DROPPED' : 'RESPONSE_DELIVERED',
        status: String(response.status),
        bodyDigest,
        downstreamAttempts: '1',
      };
    } catch (error) {
      return {
        kind: 'TRANSPORT_ERROR',
        errorName: error instanceof Error ? error.name : 'UnknownError',
        downstreamAttempts: '1',
      };
    }
  }
}
