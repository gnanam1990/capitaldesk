import { violate } from './errors.js';

/**
 * The venue origins each deployment environment may contact.
 *
 * This lives in layer 0 because two independent components must agree on it exactly and
 * neither may be the authority for the other: `@capitaldesk/config` refuses a misconfigured
 * `CAPITALDESK_VENUE_BASE_URL` at startup, and the read transport refuses at construction to
 * be pointed anywhere else. Two copies of this table would eventually differ, and the
 * difference would be discovered as a signed request sent to whoever owned the other host.
 *
 * The distinction that matters: `production-read-only` observes a live account and can never
 * hold write capability, so `api.binance.com` is reachable only from that environment and a
 * live host is never permitted for a non-production one.
 */
export const DEPLOYMENT_ENVIRONMENTS = ['local', 'testnet', 'production-read-only'] as const;
export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export const APPROVED_VENUE_ORIGINS: Readonly<Record<DeploymentEnvironment, readonly string[]>> =
  Object.freeze({
    local: ['http://127.0.0.1:9443', 'http://localhost:9443'],
    testnet: ['https://testnet.binance.vision'],
    'production-read-only': ['https://api.binance.com'],
  });

/** Origins that route to real money. Never permitted for a non-production deployment. */
export const LIVE_VENUE_ORIGINS: ReadonlySet<string> = new Set(['https://api.binance.com']);

export function isApprovedVenueOrigin(deployment: DeploymentEnvironment, origin: string): boolean {
  return APPROVED_VENUE_ORIGINS[deployment].includes(origin);
}

/**
 * Refuse an origin this deployment may not contact.
 *
 * Called at construction, before any request exists. A check that ran at send time would
 * already have a signed query string and an API key header in hand.
 */
export function assertApprovedVenueOrigin(deployment: DeploymentEnvironment, origin: string): void {
  if (!isApprovedVenueOrigin(deployment, origin)) {
    violate(
      'IDENTITY_ENVIRONMENT_MISMATCH',
      `${origin} is not an approved venue origin for a ${deployment} deployment`,
      { deployment, origin },
    );
  }
}
