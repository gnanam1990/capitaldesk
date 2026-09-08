import { z } from 'zod';
import { schemaUnrecognized } from './failures.js';
import type { ReadEndpointName } from './endpoints.js';

/**
 * Narrow decoding of raw venue text (prompt 05 tasks 2 and 5; ADR-0004).
 *
 * Two rules run through everything here.
 *
 * **Wide in, narrow out.** What the product may submit is narrow; what it may observe is
 * whatever the venue decides to send. An unrecognised status is preserved raw and mapped to
 * `UNSUPPORTED_OBSERVATION`, which quarantines the affected accounting. It is never mapped
 * onto the nearest familiar status, because that is precisely how a product invents a fact.
 *
 * **Never a float.** Every quantity crosses into integer atoms by exact string arithmetic.
 * There is no `parseFloat`, no `Number()` on a money field and no rounding: `0.1` at scale 8
 * is 10000000 atoms, and a value carrying more precision than the venue's declared scale is a
 * contradiction to surface rather than a number to tidy away.
 *
 * A failure here is always a typed `ReadFailure`, never an empty result. An empty balance list
 * reads as "the account holds nothing" and an empty trade list reads as "no fills occurred";
 * both are lies that release capital.
 */

/** Every order status the venue documents, in the order `enums.md` lists them. */
export const KNOWN_ORDER_STATUSES = [
  'NEW',
  'PENDING_NEW',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'PENDING_CANCEL',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
] as const;

/**
 * The statuses this build has accounting for.
 *
 * `PENDING_NEW` is documented upstream but is absent from this repository's
 * `venue_orders_status_known` CHECK, written in module 04. Adopting it here would be an
 * undesigned accounting decision, so it is preserved raw and quarantined instead — the
 * direction ADR-0004 section 4 prescribes. Supporting it needs its own ADR.
 */
export const SUPPORTED_ORDER_STATUSES = [
  'NEW',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'PENDING_CANCEL',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
] as const;

export type SupportedOrderStatus = (typeof SUPPORTED_ORDER_STATUSES)[number];
export type MappedOrderStatus = SupportedOrderStatus | 'UNSUPPORTED_OBSERVATION';

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_ORDER_STATUSES);

export interface MappedStatus {
  readonly mapped: MappedOrderStatus;
  /** Exactly what the venue said, kept whether or not this build understands it. */
  readonly raw: string;
}

export function mapOrderStatus(raw: string): MappedStatus {
  return SUPPORTED.has(raw)
    ? { mapped: raw as SupportedOrderStatus, raw }
    : { mapped: 'UNSUPPORTED_OBSERVATION', raw };
}

/** An exact decimal: optional sign, digits, optionally a fraction. Nothing else. */
const EXACT_DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * A decimal string as integer atoms at the given scale, exactly.
 *
 * Refuses anything that is not an exact decimal, including `1e8`, `NaN`, `Infinity`, `0x10`
 * and a thousands separator. Refuses more precision than the scale rather than rounding: the
 * venue told us its scale, so a longer fraction is a contradiction, and rounding it away
 * silently discards money.
 */
export function parseScaledAtoms(value: string, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 30) {
    throw new RangeError(`asset scale ${String(scale)} is not a usable precision`);
  }
  const text = value.trim();
  if (!EXACT_DECIMAL.test(text)) {
    throw new TypeError(`"${value}" is not an exact decimal`);
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '', fraction = ''] = unsigned.split('.');
  if (fraction.length > scale) {
    throw new RangeError(
      `"${value}" carries more precision than the venue's declared scale of ${String(scale)}`,
    );
  }
  const atoms = BigInt(whole + fraction.padEnd(scale, '0'));
  return negative ? -atoms : atoms;
}

/**
 * A venue integer identity, kept as a string.
 *
 * JSON numbers arrive as doubles, so an id past `Number.MAX_SAFE_INTEGER` is already corrupted
 * before this code sees it. Refusing is the only honest response: a silently altered order or
 * trade id would correlate one order's fills to another.
 */
function identityOf(value: unknown, what: string): string {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) throw new TypeError(`${what} identity "${value}" is not an integer`);
    return value;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${what} identity is not an integer`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} identity ${String(value)} is beyond a safe integer`);
  }
  return String(value);
}

function parseJson(endpoint: ReadEndpointName, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw schemaUnrecognized(endpoint, 'the response body is not JSON');
  }
}

/** Run a decoder, converting any thrown reason into a typed schema failure. */
function decoded<T>(endpoint: ReadEndpointName, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof Error && error.name === 'ReadFailure') throw error;
    throw schemaUnrecognized(endpoint, error instanceof Error ? error.message : 'unknown shape');
  }
}

// --- the venue's error envelope ------------------------------------------------------

const venueErrorSchema = z.object({ code: z.number().int(), msg: z.string() });

export interface VenueError {
  readonly code: number;
  readonly msg: string;
}

/** The documented `{code, msg}` envelope, or null when the body is not one. */
export function decodeVenueError(body: string): VenueError | null {
  try {
    const parsed = venueErrorSchema.safeParse(JSON.parse(body));
    return parsed.success ? { code: parsed.data.code, msg: parsed.data.msg } : null;
  } catch {
    return null;
  }
}

// --- account -------------------------------------------------------------------------

const balanceSchema = z.object({ asset: z.string().min(1), free: z.string(), locked: z.string() });
const accountSchema = z.object({
  accountType: z.string().min(1),
  updateTime: z.number().int(),
  balances: z.array(balanceSchema),
  permissions: z.array(z.string()).optional(),
  canTrade: z.boolean().optional(),
  canWithdraw: z.boolean().optional(),
  canDeposit: z.boolean().optional(),
  // The stable authenticated account id. Everything in this product is scoped by it, so a
  // response without one cannot be attributed and is refused.
  uid: z.union([z.number().int(), z.string()]),
});

export interface AccountBalance {
  readonly asset: string;
  readonly freeAtoms: bigint;
  readonly lockedAtoms: bigint;
}

export interface AccountSnapshot {
  /** The venue's `uid`, as a string: the stable authenticated account identity. */
  readonly stableAccountId: string;
  readonly accountType: string;
  readonly updateTime: number;
  readonly balances: readonly AccountBalance[];
  readonly permissions: readonly string[];
  readonly canTrade: boolean | null;
}

export function decodeAccount(body: string, defaultScale: number): AccountSnapshot {
  return decoded('account', () => {
    const raw = accountSchema.parse(parseJson('account', body));
    return {
      stableAccountId: identityOf(raw.uid, 'account'),
      accountType: raw.accountType,
      updateTime: raw.updateTime,
      balances: raw.balances.map((balance) => ({
        asset: balance.asset,
        freeAtoms: parseScaledAtoms(balance.free, defaultScale),
        lockedAtoms: parseScaledAtoms(balance.locked, defaultScale),
      })),
      permissions: raw.permissions ?? [],
      canTrade: raw.canTrade ?? null,
    };
  });
}

// --- exchange information ------------------------------------------------------------

const filterSchema = z.looseObject({ filterType: z.string().min(1) });
const symbolSchema = z.object({
  symbol: z.string().min(1),
  status: z.string().min(1),
  baseAsset: z.string().min(1),
  quoteAsset: z.string().min(1),
  baseAssetPrecision: z.number().int().min(0).max(30),
  quoteAssetPrecision: z.number().int().min(0).max(30),
  baseCommissionPrecision: z.number().int().min(0).max(30).optional(),
  quoteCommissionPrecision: z.number().int().min(0).max(30).optional(),
  orderTypes: z.array(z.string()),
  isSpotTradingAllowed: z.boolean().optional(),
  filters: z.array(filterSchema),
});
const exchangeInfoSchema = z.object({
  serverTime: z.number().int().optional(),
  symbols: z.array(symbolSchema),
});

export interface PriceFilter {
  readonly minAtoms: bigint;
  readonly maxAtoms: bigint;
  readonly tickAtoms: bigint;
}
export interface LotFilter {
  readonly minAtoms: bigint;
  readonly maxAtoms: bigint;
  readonly stepAtoms: bigint;
}
export interface NotionalFilter {
  readonly minAtoms: bigint;
  readonly maxAtoms: bigint | null;
}

export interface SymbolContext {
  readonly symbol: string;
  readonly status: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly baseAssetPrecision: number;
  readonly quoteAssetPrecision: number;
  readonly baseCommissionPrecision: number | null;
  readonly quoteCommissionPrecision: number | null;
  readonly orderTypes: readonly string[];
  readonly price: PriceFilter | null;
  readonly lot: LotFilter | null;
  readonly notional: NotionalFilter | null;
  /**
   * Every filter exactly as sent, including ones this build does not model.
   *
   * A filter change during a cut has to be detectable, and a filter type introduced upstream
   * must still reach the evidence rather than being dropped on the floor.
   */
  readonly rawFilters: readonly Readonly<Record<string, unknown>>[];
  readonly serverTime: number | null;
}

function filterOf(
  filters: readonly Readonly<Record<string, unknown>>[],
  type: string,
): Readonly<Record<string, unknown>> | undefined {
  return filters.find((filter) => filter['filterType'] === type);
}

function atomsField(
  filter: Readonly<Record<string, unknown>> | undefined,
  field: string,
  scale: number,
): bigint | null {
  const value = filter?.[field];
  return typeof value === 'string' ? parseScaledAtoms(value, scale) : null;
}

export function decodeExchangeInfo(body: string, symbol: string): SymbolContext {
  return decoded('exchangeInfo', () => {
    const raw = exchangeInfoSchema.parse(parseJson('exchangeInfo', body));
    const found = raw.symbols.find((entry) => entry.symbol === symbol);
    if (found === undefined) {
      // Taking the first entry would silently describe a different market.
      throw schemaUnrecognized('exchangeInfo', `the response does not contain symbol ${symbol}`);
    }
    const filters = found.filters as Readonly<Record<string, unknown>>[];
    const price = filterOf(filters, 'PRICE_FILTER');
    const lot = filterOf(filters, 'LOT_SIZE');
    const notional = filterOf(filters, 'NOTIONAL');
    const quote = found.quoteAssetPrecision;
    const base = found.baseAssetPrecision;
    const minPrice = atomsField(price, 'minPrice', quote);
    const minQty = atomsField(lot, 'minQty', base);
    const minNotional = atomsField(notional, 'minNotional', quote);
    return {
      symbol: found.symbol,
      status: found.status,
      baseAsset: found.baseAsset,
      quoteAsset: found.quoteAsset,
      baseAssetPrecision: base,
      quoteAssetPrecision: quote,
      baseCommissionPrecision: found.baseCommissionPrecision ?? null,
      quoteCommissionPrecision: found.quoteCommissionPrecision ?? null,
      orderTypes: found.orderTypes,
      price:
        minPrice === null
          ? null
          : {
              minAtoms: minPrice,
              maxAtoms: atomsField(price, 'maxPrice', quote) ?? 0n,
              tickAtoms: atomsField(price, 'tickSize', quote) ?? 0n,
            },
      lot:
        minQty === null
          ? null
          : {
              minAtoms: minQty,
              maxAtoms: atomsField(lot, 'maxQty', base) ?? 0n,
              stepAtoms: atomsField(lot, 'stepSize', base) ?? 0n,
            },
      notional:
        minNotional === null
          ? null
          : { minAtoms: minNotional, maxAtoms: atomsField(notional, 'maxNotional', quote) },
      rawFilters: filters,
      serverTime: raw.serverTime ?? null,
    };
  });
}

// --- orders --------------------------------------------------------------------------

const orderSchema = z.object({
  symbol: z.string().min(1),
  orderId: z.union([z.number(), z.string()]),
  clientOrderId: z.string().optional(),
  price: z.string().optional(),
  origQty: z.string().optional(),
  executedQty: z.string(),
  cummulativeQuoteQty: z.string(),
  status: z.string(),
  timeInForce: z.string().optional(),
  type: z.string().optional(),
  side: z.string().optional(),
  time: z.number().int().optional(),
  updateTime: z.number().int().optional(),
  selfTradePreventionMode: z.string().optional(),
});

/** The asset scales a decode needs, per symbol. */
export interface Scales {
  readonly base: number;
  readonly quote: number;
  /** Scale per commission asset. A fee asset absent from this map is refused, never guessed. */
  readonly commission?: Readonly<Record<string, number>>;
}

export interface VenueOrderObservation {
  readonly symbol: string;
  readonly venueOrderId: string;
  readonly clientOrderId: string | null;
  readonly status: MappedOrderStatus;
  /** Exactly what the venue said, whether or not this build understands it. */
  readonly rawStatus: string;
  readonly executedBaseAtoms: bigint;
  readonly cumulativeQuoteAtoms: bigint;
  readonly timeInForce: string | null;
  readonly orderType: string | null;
  readonly side: string | null;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly selfTradePreventionMode: string | null;
}

function orderFrom(value: unknown, scales: Scales): VenueOrderObservation {
  const raw = orderSchema.parse(value);
  const status = mapOrderStatus(raw.status);
  return {
    symbol: raw.symbol,
    venueOrderId: identityOf(raw.orderId, 'order'),
    // An absent correlation is null, never ''. An empty string is a value that compares equal
    // to another empty string, which would correlate two unrelated orders to each other.
    clientOrderId:
      raw.clientOrderId === undefined || raw.clientOrderId === '' ? null : raw.clientOrderId,
    status: status.mapped,
    rawStatus: status.raw,
    executedBaseAtoms: parseScaledAtoms(raw.executedQty, scales.base),
    cumulativeQuoteAtoms: parseScaledAtoms(raw.cummulativeQuoteQty, scales.quote),
    timeInForce: raw.timeInForce ?? null,
    orderType: raw.type ?? null,
    side: raw.side ?? null,
    createdAt: raw.time ?? null,
    updatedAt: raw.updateTime ?? null,
    selfTradePreventionMode: raw.selfTradePreventionMode ?? null,
  };
}

export function decodeOrder(body: string, scales: Scales): VenueOrderObservation {
  return decoded('order', () => orderFrom(parseJson('order', body), scales));
}

/**
 * The account-wide open-order scan (ADR-0002 condition C2).
 *
 * Scales are not applied here: this scan spans every symbol on the account, including ones
 * whose precision this pool has never fetched, and inventing a scale for them would be worse
 * than reporting the identities. Quantities come from the per-symbol order read.
 */
export interface OpenOrderObservation {
  readonly symbol: string;
  readonly venueOrderId: string;
  readonly clientOrderId: string | null;
  readonly status: MappedOrderStatus;
  readonly rawStatus: string;
  readonly updatedAt: number | null;
}

export function decodeOpenOrders(body: string): readonly OpenOrderObservation[] {
  return decoded('openOrders', () => {
    const parsed = parseJson('openOrders', body);
    if (!Array.isArray(parsed)) {
      // "No open orders" is the answer that lets a cut be declared clean, so it may only ever
      // come from an actual empty array.
      throw schemaUnrecognized('openOrders', 'the response is not an array of orders');
    }
    return parsed.map((entry) => {
      const raw = orderSchema
        .pick({ symbol: true, orderId: true, clientOrderId: true, status: true, updateTime: true })
        .parse(entry);
      const status = mapOrderStatus(raw.status);
      return {
        symbol: raw.symbol,
        venueOrderId: identityOf(raw.orderId, 'order'),
        clientOrderId:
          raw.clientOrderId === undefined || raw.clientOrderId === '' ? null : raw.clientOrderId,
        status: status.mapped,
        rawStatus: status.raw,
        updatedAt: raw.updateTime ?? null,
      };
    });
  });
}

// --- trades --------------------------------------------------------------------------

const tradeSchema = z.object({
  symbol: z.string().min(1),
  id: z.union([z.number(), z.string()]),
  orderId: z.union([z.number(), z.string()]),
  price: z.string(),
  qty: z.string(),
  quoteQty: z.string(),
  commission: z.string(),
  commissionAsset: z.string().min(1),
  time: z.number().int(),
  isBuyer: z.boolean(),
  isMaker: z.boolean(),
});

export interface VenueTradeObservation {
  readonly symbol: string;
  readonly venueTradeId: string;
  readonly venueOrderId: string;
  readonly baseAtoms: bigint;
  readonly quoteAtoms: bigint;
  readonly commissionAsset: string;
  readonly commissionAtoms: bigint;
  readonly tradedAt: number;
  readonly isBuyer: boolean;
  readonly isMaker: boolean;
}

export function decodeTrades(body: string, scales: Scales): readonly VenueTradeObservation[] {
  return decoded('myTrades', () => {
    const parsed = parseJson('myTrades', body);
    if (!Array.isArray(parsed)) {
      // T-021: an empty trade list is what lets a reservation be released, so it may only ever
      // come from an actual empty array.
      throw schemaUnrecognized('myTrades', 'the response is not an array of trades');
    }
    return parsed.map((entry) => {
      const raw = tradeSchema.parse(entry);
      // The fee is denominated in its own asset. Using the base or quote scale here is exactly
      // how a commission lands in the wrong asset's accounting, so an unknown fee asset is
      // refused rather than assigned a plausible scale.
      const commissionScale = scales.commission?.[raw.commissionAsset];
      if (commissionScale === undefined) {
        throw schemaUnrecognized(
          'myTrades',
          `no declared scale for commission asset ${raw.commissionAsset}`,
        );
      }
      return {
        symbol: raw.symbol,
        venueTradeId: identityOf(raw.id, 'trade'),
        venueOrderId: identityOf(raw.orderId, 'order'),
        baseAtoms: parseScaledAtoms(raw.qty, scales.base),
        quoteAtoms: parseScaledAtoms(raw.quoteQty, scales.quote),
        commissionAsset: raw.commissionAsset,
        commissionAtoms: parseScaledAtoms(raw.commission, commissionScale),
        tradedAt: raw.time,
        isBuyer: raw.isBuyer,
        isMaker: raw.isMaker,
      };
    });
  });
}
