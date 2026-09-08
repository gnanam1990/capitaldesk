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

/**
 * Frozen through, not merely at the top level.
 *
 * `Object.freeze` on the record alone leaves each array mutable, so
 * `APPROVED_VENUE_ORIGINS.testnet.push('https://attacker.invalid')` would have widened the
 * allowlist at runtime for every component that consults it.
 */
export const APPROVED_VENUE_ORIGINS: Readonly<Record<DeploymentEnvironment, readonly string[]>> =
  Object.freeze({
    local: Object.freeze(['http://127.0.0.1:9443', 'http://localhost:9443']),
    testnet: Object.freeze(['https://testnet.binance.vision']),
    'production-read-only': Object.freeze(['https://api.binance.com']),
  });

/** Origins that route to real money. Never permitted for a non-production deployment. */
export const LIVE_VENUE_ORIGINS: ReadonlySet<string> = Object.freeze(
  new Set(['https://api.binance.com']),
);

export function isApprovedVenueOrigin(deployment: DeploymentEnvironment, origin: string): boolean {
  // A deployment name that is not one of ours has no approved origins — not "all of them", and
  // not a TypeError. The types say this cannot happen; the value arrives from configuration.
  return (APPROVED_VENUE_ORIGINS[deployment] ?? []).includes(origin);
}

/**
 * Refuse an origin this deployment may not contact.
 *
 * Called at construction, before any request exists. A check that ran at send time would
 * already have a signed query string and an API key header in hand.
 */
export function assertApprovedVenueOrigin(deployment: DeploymentEnvironment, origin: string): void {
  if (!DEPLOYMENT_ENVIRONMENTS.includes(deployment)) {
    // Reached only when an unvalidated string arrives as a deployment. Without this the
    // membership test below threw `undefined.includes` — an internal error where a controlled
    // environment refusal belongs.
    violate('IDENTITY_ENVIRONMENT_MISMATCH', 'unknown deployment environment', {
      deployment: String(deployment),
    });
  }
  if (!isApprovedVenueOrigin(deployment, origin)) {
    violate(
      'IDENTITY_ENVIRONMENT_MISMATCH',
      `${origin} is not an approved venue origin for a ${deployment} deployment`,
      { deployment, origin },
    );
  }
}

/**
 * The economic environment a deployment observes.
 *
 * `production-read-only` observes the live account, so its economic environment is
 * `production` even though it can never hold write capability. Duplicated nowhere else: the
 * read boundary compares its own claimed environment against this, and two mappings would
 * eventually disagree about which account's facts were being recorded.
 */
export function economicEnvironmentOfDeployment(
  deployment: DeploymentEnvironment,
): 'local' | 'testnet' | 'production' {
  switch (deployment) {
    case 'local':
      return 'local';
    case 'testnet':
      return 'testnet';
    case 'production-read-only':
      return 'production';
  }
}
