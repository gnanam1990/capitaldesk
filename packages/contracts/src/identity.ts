import { violate } from './errors.js';

/**
 * Economic identities (TDD section 4).
 *
 * Identity is never an API-key alias, a display label or a UI selection. Every economic
 * record resolves to a venue, an environment, a stable authenticated account id and a
 * baseline epoch, so a testnet reset or a rotated credential cannot silently re-link
 * unrelated records (INV-14, T-031, T-032, T-056).
 */

export const VENUES = ['binance-spot'] as const;
export type Venue = (typeof VENUES)[number];

export const ENVIRONMENTS = ['local', 'testnet', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,32}$/;

function segment(name: string, value: string): string {
  if (!SEGMENT_PATTERN.test(value)) {
    violate('IDENTITY_MALFORMED', `${name} must be 1-64 chars of [A-Za-z0-9._-]`, {
      [name]: value,
    });
  }
  return value;
}

/**
 * The stable authenticated venue account, independent of which credential observed it.
 * `stableAccountId` is the venue's own durable account identifier (for Binance Spot, the
 * `uid` returned by the account endpoint) — never a key fingerprint or alias.
 */
export interface VenueAccountKey {
  readonly venue: Venue;
  readonly environment: Environment;
  readonly stableAccountId: string;
}

export function venueAccountKey(
  venue: Venue,
  environment: Environment,
  stableAccountId: string,
): VenueAccountKey {
  return Object.freeze({
    venue,
    environment,
    stableAccountId: segment('stableAccountId', stableAccountId),
  });
}

export function formatVenueAccountKey(key: VenueAccountKey): string {
  return `${key.venue}:${key.environment}:${key.stableAccountId}`;
}

/** A governed pool: one workspace governing one venue account under one baseline epoch. */
export interface PoolId {
  readonly workspaceId: string;
  readonly account: VenueAccountKey;
  readonly baselineEpoch: number;
}

export function poolId(
  workspaceId: string,
  account: VenueAccountKey,
  baselineEpoch: number,
): PoolId {
  if (!Number.isSafeInteger(baselineEpoch) || baselineEpoch < 1) {
    violate('IDENTITY_MALFORMED', 'baselineEpoch must be an integer >= 1', {
      baselineEpoch: String(baselineEpoch),
    });
  }
  return Object.freeze({
    workspaceId: segment('workspaceId', workspaceId),
    account,
    baselineEpoch,
  });
}

export function formatPoolId(id: PoolId): string {
  return `${id.workspaceId}/${formatVenueAccountKey(id.account)}/e${id.baselineEpoch}`;
}

export function symbolCode(value: string): string {
  if (!SYMBOL_PATTERN.test(value)) {
    violate('IDENTITY_MALFORMED', 'symbol must be 2-32 uppercase alphanumerics', { symbol: value });
  }
  return value;
}

/** A venue order, scoped by pool (and therefore by account, environment and epoch). */
export interface OrderKey {
  readonly pool: PoolId;
  readonly symbol: string;
  readonly venueOrderId: string;
}

export function orderKey(pool: PoolId, symbol: string, venueOrderId: string): OrderKey {
  return Object.freeze({
    pool,
    symbol: symbolCode(symbol),
    venueOrderId: segment('venueOrderId', venueOrderId),
  });
}

export function formatOrderKey(key: OrderKey): string {
  return `${formatPoolId(key.pool)}/${key.symbol}/o${key.venueOrderId}`;
}

/** A single authoritative trade. Trade ids are only unique inside their order identity. */
export interface FillKey {
  readonly order: OrderKey;
  readonly venueTradeId: string;
}

export function fillKey(order: OrderKey, venueTradeId: string): FillKey {
  return Object.freeze({ order, venueTradeId: segment('venueTradeId', venueTradeId) });
}

export function formatFillKey(key: FillKey): string {
  return `${formatOrderKey(key.order)}/t${key.venueTradeId}`;
}

/** The unique current-target slot for one strategy on one symbol inside one pool. */
export interface StrategyTargetKey {
  readonly pool: PoolId;
  readonly strategyId: string;
  readonly symbol: string;
}

export function strategyTargetKey(
  pool: PoolId,
  strategyId: string,
  symbol: string,
): StrategyTargetKey {
  return Object.freeze({
    pool,
    strategyId: segment('strategyId', strategyId),
    symbol: symbolCode(symbol),
  });
}

export function formatStrategyTargetKey(key: StrategyTargetKey): string {
  return `${formatPoolId(key.pool)}/${key.strategyId}/${key.symbol}`;
}

export function sameVenueAccount(a: VenueAccountKey, b: VenueAccountKey): boolean {
  return (
    a.venue === b.venue &&
    a.environment === b.environment &&
    a.stableAccountId === b.stableAccountId
  );
}

export function samePool(a: PoolId, b: PoolId): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.baselineEpoch === b.baselineEpoch &&
    sameVenueAccount(a.account, b.account)
  );
}

/**
 * Assert that two records belong to the same pool before they are allowed to interact.
 * Cross-epoch and cross-environment correlation is a release blocker (TEST-PLAN T-031/T-032).
 */
export function requireSamePool(a: PoolId, b: PoolId, context: string): void {
  if (samePool(a, b)) return;
  if (a.account.environment !== b.account.environment) {
    violate('IDENTITY_ENVIRONMENT_MISMATCH', `${context}: environments differ`, {
      left: formatPoolId(a),
      right: formatPoolId(b),
    });
  }
  if (
    sameVenueAccount(a.account, b.account) &&
    a.workspaceId === b.workspaceId &&
    a.baselineEpoch !== b.baselineEpoch
  ) {
    violate('IDENTITY_EPOCH_MISMATCH', `${context}: baseline epochs differ`, {
      left: formatPoolId(a),
      right: formatPoolId(b),
    });
  }
  violate('IDENTITY_SCOPE_MISMATCH', `${context}: records belong to different pools`, {
    left: formatPoolId(a),
    right: formatPoolId(b),
  });
}
