import { MAX_ATOMS, MAX_ATOM_DIGITS } from '@capitaldesk/contracts';
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
 * A **signed** decimal string as integer atoms at the given scale, exactly.
 *
 * Refuses anything that is not an exact decimal, including `1e8`, `NaN`, `Infinity`, `0x10`
 * and a thousands separator. Refuses more precision than the scale rather than rounding: the
 * venue told us its scale, so a longer fraction is a contradiction, and rounding it away
 * silently discards money.
 *
 * This primitive accepts a sign because some venue facts legitimately carry one — a balance
 * *delta* on an event stream, for instance. No account balance, order quantity, trade
 * quantity, quote amount, commission or positive filter bound is one of those, so those all
 * go through {@link parseNonNegativeAtoms} or {@link parsePositiveAtoms} instead. Reaching for
 * this function directly on an economic source field is how a negative quantity flows into a
 * normalized fact and out the other side as a claim.
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
  const digits = whole + fraction.padEnd(scale, '0');
  // The magnitude bound the money contract declares, checked on the digit string before
  // BigInt sees it. `BigInt` itself is unbounded, so a pathological response could otherwise
  // produce a value no column in this system can hold and no downstream arithmetic expects —
  // discovered as a numeric overflow deep in the ledger rather than as a bad response here.
  if (digits.replace(/^0+/, '').length > MAX_ATOM_DIGITS) {
    throw new RangeError(
      `"${value}" exceeds the ${String(MAX_ATOM_DIGITS)}-digit atom magnitude this system supports`,
    );
  }
  const atoms = BigInt(digits);
  if (atoms > MAX_ATOMS) {
    throw new RangeError(`"${value}" exceeds the maximum atom magnitude`);
  }
  return negative ? -atoms : atoms;
}

/**
 * A quantity that cannot be negative: a balance, a filled quantity, a fee.
 *
 * The venue does not send negative balances, so one arriving is a contradiction in the source,
 * not a value to carry forward. Normalizing it silently would put a negative claim into the
 * accounting path, where every downstream invariant is written assuming it cannot be there.
 */
export function parseNonNegativeAtoms(value: string, scale: number, what: string): bigint {
  const atoms = parseScaledAtoms(value, scale);
  if (atoms < 0n) throw new RangeError(`${what} is negative ("${value}")`);
  return atoms;
}

/** A bound that must be strictly positive: a tick size, a step size. */
export function parsePositiveAtoms(value: string, scale: number, what: string): bigint {
  const atoms = parseScaledAtoms(value, scale);
  if (atoms <= 0n) throw new RangeError(`${what} must be positive ("${value}")`);
  return atoms;
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
    // Canonical non-negative digits. A leading zero would give one id two spellings, and a
    // sign has no meaning in an identity — a negative one compared as a cursor would order
    // before every real trade.
    if (!/^(0|[1-9]\d*)$/.test(value)) {
      throw new TypeError(`${what} identity "${value}" is not a canonical non-negative integer`);
    }
    return value;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${what} identity is not an integer`);
  }
  if (value < 0) {
    throw new RangeError(`${what} identity ${String(value)} is negative`);
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

/**
 * The declared scale of every asset this decode may normalize.
 *
 * There is no default. Applying one invented scale across an account-wide balance list is a
 * guess repeated once per asset: the venue publishes precision per symbol, and an asset whose
 * precision this build has not fetched has no proven scale at all. Refusing names the asset,
 * which is actionable; guessing produces a balance that is wrong by orders of magnitude and
 * looks entirely normal.
 */
export type AssetScales = Readonly<Record<string, number>>;

export interface AccountSnapshot {
  /** The venue's `uid`, as a string: the stable authenticated account identity. */
  readonly stableAccountId: string;
  readonly accountType: string;
  readonly updateTime: number;
  readonly balances: readonly AccountBalance[];
  readonly permissions: readonly string[];
  readonly canTrade: boolean | null;
}

/**
 * An account snapshot, normalized only for assets whose scale is proven.
 *
 * `assetScales` must name every asset in the response. A balance the caller cannot scale is
 * refused rather than normalized, because there is no safe fallback: the scale decides the
 * magnitude, and the wrong one produces a number that is wrong by orders of magnitude and
 * looks entirely normal.
 */
export function decodeAccount(body: string, assetScales: AssetScales): AccountSnapshot {
  return decoded('account', () => {
    const raw = accountSchema.parse(parseJson('account', body));
    return {
      stableAccountId: identityOf(raw.uid, 'account'),
      accountType: raw.accountType,
      updateTime: raw.updateTime,
      balances: raw.balances.map((balance) => {
        const scale = assetScales[balance.asset];
        if (scale === undefined) {
          throw schemaUnrecognized(
            'account',
            `no declared scale for asset ${balance.asset}; its balance cannot be normalized`,
          );
        }
        return {
          asset: balance.asset,
          freeAtoms: parseNonNegativeAtoms(balance.free, scale, `${balance.asset} free balance`),
          lockedAtoms: parseNonNegativeAtoms(
            balance.locked,
            scale,
            `${balance.asset} locked balance`,
          ),
        };
      }),
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

/**
 * The price rules for a symbol, with each part separately enabled.
 *
 * `filters.md` states it explicitly: "Any of the above variables can be set to 0, which
 * disables that rule in the price filter." So a zero is a real, meaningful value from the
 * venue and must not be refused — but it must not be carried as an active bound either. A
 * tick of zero read as an active interval is a zero divisor; read as `null` it is what the
 * venue said, which is that there is no tick rule.
 *
 * A *missing* field is different and remains a schema failure: the venue always sends all
 * three, so an absent one means the response is not the shape this build decoded.
 */
export interface PriceFilter {
  /** null when the venue disabled this rule by sending an explicit 0. */
  readonly minAtoms: bigint | null;
  readonly maxAtoms: bigint | null;
  readonly tickAtoms: bigint | null;
}
export interface LotFilter {
  readonly minAtoms: bigint;
  readonly maxAtoms: bigint;
  readonly stepAtoms: bigint;
}
/**
 * The `NOTIONAL` filter: an acceptable notional *range*.
 *
 * `filters.md` documents it as a range and its `/exchangeInfo` shape carries `minNotional`,
 * `applyMinToMarket`, `maxNotional`, `applyMaxToMarket` and `avgPriceMins`. It states no
 * missing-means-disabled rule, unlike `PRICE_FILTER`, so every part is required: treating an
 * absent `maxNotional` as "no maximum" would be this build inventing a semantic the venue
 * does not define.
 */
export interface NotionalFilter {
  readonly minAtoms: bigint;
  readonly maxAtoms: bigint;
  readonly applyMinToMarket: boolean;
  readonly applyMaxToMarket: boolean;
  readonly avgPriceMins: number;
}

/**
 * The `MIN_NOTIONAL` filter: a distinct, first-class filter, not a subset of `NOTIONAL`.
 *
 * "An order will pass this filter evaluation if: `price` * `quantity` >= `minNotional`". It
 * applies to a LIMIT order unconditionally; `applyToMarket` only decides whether MARKET orders
 * are covered too. Since this product submits LIMIT IOC, a symbol carrying this filter cannot
 * have a legal order validated without it — preserving it only as unmodelled raw data would
 * leave the market context unable to say whether an order is legal.
 */
export interface MinNotionalFilter {
  readonly minAtoms: bigint;
  readonly applyToMarket: boolean;
  readonly avgPriceMins: number;
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
  /** The separate `MIN_NOTIONAL` filter, when the symbol carries one. */
  readonly minNotional: MinNotionalFilter | null;
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

/**
 * Exact schemas for the filters this build actually models.
 *
 * An earlier version read each field with `?? 0n`, so a PRICE_FILTER that arrived without a
 * `tickSize` normalized to a tick of zero — a filter that is not disabled but impossible, and
 * one that every downstream price check would then evaluate against. A known filter is either
 * complete and coherent or it is `SOURCE_SCHEMA_UNRECOGNIZED`. There is no third answer, and
 * certainly not a fabricated bound.
 *
 * A filter type this build does *not* model is a different matter: it is preserved in
 * `rawFilters` and ignored, because refusing every upstream addition would break on release
 * day for a filter the product never consults.
 */
const priceFilterSchema = z.object({
  minPrice: z.string(),
  maxPrice: z.string(),
  tickSize: z.string(),
});
const lotFilterSchema = z.object({
  minQty: z.string(),
  maxQty: z.string(),
  stepSize: z.string(),
});
const notionalFilterSchema = z.object({
  minNotional: z.string(),
  maxNotional: z.string(),
  applyMinToMarket: z.boolean(),
  applyMaxToMarket: z.boolean(),
  avgPriceMins: z.number().int().min(0),
});
const minNotionalFilterSchema = z.object({
  minNotional: z.string(),
  applyToMarket: z.boolean(),
  avgPriceMins: z.number().int().min(0),
});

function assertOrderedBounds(what: string, min: bigint, max: bigint): void {
  if (max < min) {
    throw new RangeError(`${what} maximum ${String(max)} is below its minimum ${String(min)}`);
  }
}

/**
 * A price-filter part: null when the venue disabled it with an explicit 0.
 *
 * Negative is still refused — the venue documents 0 as "disabled", not "-1 as disabled".
 */
function enabledBound(value: string, scale: number, what: string): bigint | null {
  const atoms = parseNonNegativeAtoms(value, scale, what);
  return atoms === 0n ? null : atoms;
}

/**
 * The smallest notional a LIMIT order on this symbol may carry, in quote atoms.
 *
 * `NOTIONAL` and `MIN_NOTIONAL` are separate filters and the venue does not forbid a symbol
 * carrying both. They do not contradict each other — both are minimums, and an order must
 * pass every filter — so the binding constraint is simply the larger. That is arithmetic on
 * two stated facts, not a guess between them, which is why it is computed here rather than
 * left for each caller to reinvent.
 *
 * Null when the symbol declares neither.
 */
export function bindingMinNotionalAtoms(context: SymbolContext): bigint | null {
  const bounds = [context.notional?.minAtoms, context.minNotional?.minAtoms].filter(
    (value): value is bigint => value !== undefined,
  );
  if (bounds.length === 0) return null;
  return bounds.reduce((largest, value) => (value > largest ? value : largest));
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
    const quote = found.quoteAssetPrecision;
    const base = found.baseAssetPrecision;

    const rawPrice = filterOf(filters, 'PRICE_FILTER');
    let price: PriceFilter | null = null;
    if (rawPrice !== undefined) {
      const parsed = priceFilterSchema.parse(rawPrice);
      // Present-and-zero means the venue disabled that part; present-and-positive is a bound.
      // Absent is neither, and is refused by the schema above.
      price = {
        minAtoms: enabledBound(parsed.minPrice, quote, 'PRICE_FILTER minPrice'),
        maxAtoms: enabledBound(parsed.maxPrice, quote, 'PRICE_FILTER maxPrice'),
        tickAtoms: enabledBound(parsed.tickSize, quote, 'PRICE_FILTER tickSize'),
      };
      // Only meaningful when both ends are actually enabled.
      if (price.minAtoms !== null && price.maxAtoms !== null) {
        assertOrderedBounds('PRICE_FILTER', price.minAtoms, price.maxAtoms);
      }
    }

    const rawLot = filterOf(filters, 'LOT_SIZE');
    let lot: LotFilter | null = null;
    if (rawLot !== undefined) {
      const parsed = lotFilterSchema.parse(rawLot);
      lot = {
        minAtoms: parseNonNegativeAtoms(parsed.minQty, base, 'LOT_SIZE minQty'),
        maxAtoms: parseNonNegativeAtoms(parsed.maxQty, base, 'LOT_SIZE maxQty'),
        stepAtoms: parsePositiveAtoms(parsed.stepSize, base, 'LOT_SIZE stepSize'),
      };
      assertOrderedBounds('LOT_SIZE', lot.minAtoms, lot.maxAtoms);
    }

    const rawNotional = filterOf(filters, 'NOTIONAL');
    let notional: NotionalFilter | null = null;
    if (rawNotional !== undefined) {
      const parsed = notionalFilterSchema.parse(rawNotional);
      const minAtoms = parseNonNegativeAtoms(parsed.minNotional, quote, 'NOTIONAL minNotional');
      const maxAtoms = parseNonNegativeAtoms(parsed.maxNotional, quote, 'NOTIONAL maxNotional');
      assertOrderedBounds('NOTIONAL', minAtoms, maxAtoms);
      notional = {
        minAtoms,
        maxAtoms,
        applyMinToMarket: parsed.applyMinToMarket,
        applyMaxToMarket: parsed.applyMaxToMarket,
        avgPriceMins: parsed.avgPriceMins,
      };
    }

    const rawMinNotional = filterOf(filters, 'MIN_NOTIONAL');
    let minNotional: MinNotionalFilter | null = null;
    if (rawMinNotional !== undefined) {
      const parsed = minNotionalFilterSchema.parse(rawMinNotional);
      minNotional = {
        minAtoms: parseNonNegativeAtoms(parsed.minNotional, quote, 'MIN_NOTIONAL minNotional'),
        applyToMarket: parsed.applyToMarket,
        avgPriceMins: parsed.avgPriceMins,
      };
    }

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
      price,
      lot,
      notional,
      minNotional,
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
    executedBaseAtoms: parseNonNegativeAtoms(raw.executedQty, scales.base, 'executedQty'),
    cumulativeQuoteAtoms: parseNonNegativeAtoms(
      raw.cummulativeQuoteQty,
      scales.quote,
      'cummulativeQuoteQty',
    ),
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
        baseAtoms: parseNonNegativeAtoms(raw.qty, scales.base, 'trade qty'),
        quoteAtoms: parseNonNegativeAtoms(raw.quoteQty, scales.quote, 'trade quoteQty'),
        commissionAsset: raw.commissionAsset,
        commissionAtoms: parseNonNegativeAtoms(
          raw.commission,
          commissionScale,
          `${raw.commissionAsset} commission`,
        ),
        tradedAt: raw.time,
        isBuyer: raw.isBuyer,
        isMaker: raw.isMaker,
      };
    });
  });
}
