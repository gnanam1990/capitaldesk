import {
  economicEnvironmentOfDeployment,
  violate,
  type DeploymentEnvironment,
  type Environment,
} from '@capitaldesk/contracts';
import {
  decodeAccount,
  decodeExchangeInfo,
  decodeOpenOrders,
  decodeOrder,
  decodeTrades,
  type AccountSnapshot,
  type AssetScales,
  type OpenOrderObservation,
  type Scales,
  type SymbolContext,
  type VenueOrderObservation,
  type VenueTradeObservation,
} from './decode.js';
import { READ_ENDPOINTS } from './endpoints.js';
import { schemaUnrecognized } from './failures.js';
import type { ReadOnlyTransport, ReadResult } from './transport.js';

/**
 * The account and market readers (prompt 05).
 *
 * Every result is an {@link Observation}: the fact, and the provenance that says which account
 * and environment it came from, when it was requested and answered, what the exact response
 * digested to, and how complete it is. A bare value with no provenance cannot be reconciled
 * against anything later, and the acceptance gate is that every reader result states both.
 *
 * The readers are narrow by construction. There is no method that takes an endpoint, a URL or
 * a query, and the transport underneath has none either.
 */

/** How much of the thing being read this result actually covers. */
export type Completeness =
  /** Everything in the requested range was retrieved. */
  | 'COMPLETE'
  /** More pages exist and were not fetched. The cursor says where to resume. */
  | 'PARTIAL'
  /** A single point-in-time fact with no range to be complete over. */
  | 'POINT_IN_TIME';

/**
 * Where a fact came from, attached to every reader result.
 *
 * `stableAccountId` is the venue's own `uid`, never a credential alias: ADR-0007 requires that
 * scoping is by authenticated identity, because two aliases can name one account and one alias
 * can be rotated onto another.
 */
export interface Provenance {
  readonly venue: 'binance-spot';
  readonly environment: Environment;
  /** The venue's authenticated account id, as proven by a live read. */
  readonly stableAccountId: string;
  /** The baseline epoch this observation belongs to. */
  readonly epoch: number;
  readonly endpoint: string;
  /** The request interval, both ends. */
  readonly requestedAt: string;
  readonly respondedAt: string;
  /** The venue's own timestamp for the fact, where it supplies one. */
  readonly sourceTime: string | null;
  /** sha256 of the exact response bytes. */
  readonly responseDigest: string;
  /** The request URL with credential material removed. */
  readonly requestUrl: string;
  readonly weight: number;
  readonly completeness: Completeness;
  /** The cursor a caller resumes from, when this read was paginated. */
  readonly cursor: string | null;
}

export interface Observation<T> {
  readonly value: T;
  readonly provenance: Provenance;
}

export interface ReaderIdentity {
  readonly environment: Environment;
  /**
   * The account this reader is bound to.
   *
   * Every authenticated read is checked against it. A response from a different account is not
   * a surprising value to record, it is evidence that the credential is not what the
   * configuration says it is, and reconciling one account while trading another is the exact
   * failure ADR-0007 section 3 exists to prevent.
   */
  readonly expectedStableAccountId: string;
  readonly epoch: number;
}

export interface ReaderOptions {
  readonly transport: ReadOnlyTransport;
  readonly identity: ReaderIdentity;
  /**
   * The deployment the transport was constructed for.
   *
   * Required so the two halves of the environment claim are compared rather than assumed. The
   * reader stamps `identity.environment` onto every observation while the transport decides
   * which host is contacted from its deployment; nothing previously connected them, so a
   * `testnet` reader could stamp `production` onto facts read from the testnet host, or the
   * reverse.
   */
  readonly deployment: DeploymentEnvironment;
}

function provenanceOf(
  identity: ReaderIdentity,
  stableAccountId: string,
  result: ReadResult,
  completeness: Completeness,
  sourceTime: number | null,
  cursor: string | null,
): Provenance {
  return {
    venue: 'binance-spot',
    environment: identity.environment,
    stableAccountId,
    epoch: identity.epoch,
    endpoint: READ_ENDPOINTS[result.endpoint].path,
    requestedAt: result.requestedAt.toISOString(),
    respondedAt: result.respondedAt.toISOString(),
    sourceTime: sourceTime === null ? null : new Date(sourceTime).toISOString(),
    responseDigest: result.bodyDigest,
    requestUrl: result.requestUrl,
    weight: result.weight,
    completeness,
    cursor,
  };
}

/** One page of trades, and where to resume. */
export interface TradePage {
  readonly trades: readonly VenueTradeObservation[];
  /**
   * The cursor for the next page: the last trade id seen, plus one.
   *
   * Null when this page completed the range. `fromId` is inclusive — the venue documents "If
   * `fromId` is set, it will get trades >= that `fromId`" — so resuming at the last id seen
   * would re-fetch it. That duplicate is harmless to the ledger, which deduplicates by trade
   * id, but it makes a page boundary indistinguishable from a stall.
   */
  readonly nextFromId: string | null;
}

export class BinanceSpotReader {
  readonly #transport: ReadOnlyTransport;
  readonly #identity: ReaderIdentity;
  /**
   * The account this reader has actually proven, by reading it.
   *
   * Null until `accountSnapshot` succeeds. Every other authenticated read stamps an account id
   * onto its provenance, and before this existed that id came from configuration rather than
   * from evidence — so a misconfigured or rotated credential produced order and trade
   * observations attributed to an account nothing had confirmed.
   */
  #provenAccountId: string | null = null;

  constructor(options: ReaderOptions) {
    // The environment is claimed twice — once by this reader, once by the transport's
    // deployment — and both end up in evidence. Refused at construction, before any request.
    const implied = economicEnvironmentOfDeployment(options.deployment);
    if (implied !== options.identity.environment) {
      violate(
        'IDENTITY_ENVIRONMENT_MISMATCH',
        'the reader environment does not match the transport deployment',
        { readerEnvironment: options.identity.environment, deployment: options.deployment },
      );
    }
    this.#transport = options.transport;
    this.#identity = options.identity;
  }

  /** The account id proven by a successful snapshot in this session, if any. */
  get provenAccountId(): string | null {
    return this.#provenAccountId;
  }

  /**
   * The public market context for one symbol: filters, scales and status.
   *
   * Public, so it carries no account identity of its own; the provenance still records which
   * account and epoch the reading was for, because a filter change is only meaningful relative
   * to the plans that were made under the previous one.
   */
  async marketContext(symbol: string): Promise<Observation<SymbolContext>> {
    const result = await this.#transport.read('exchangeInfo', { symbol });
    const context = decodeExchangeInfo(result.body, symbol);
    return {
      value: context,
      provenance: provenanceOf(
        this.#identity,
        this.#identity.expectedStableAccountId,
        result,
        'POINT_IN_TIME',
        context.serverTime,
        null,
      ),
    };
  }

  /**
   * Authenticated balances, with the account identity proven by the same response.
   *
   * The identity check is not a formality. `uid` is what binds this snapshot to a pool, and a
   * response from another account would otherwise be recorded as this pool's balances.
   */
  async accountSnapshot(assetScales: AssetScales): Promise<Observation<AccountSnapshot>> {
    const result = await this.#transport.read('account', {});
    const account = decodeAccount(result.body, assetScales);
    this.#assertExpectedAccount(account.stableAccountId);
    // From here the account is proven by evidence, not by configuration.
    this.#provenAccountId = account.stableAccountId;
    return {
      value: account,
      provenance: provenanceOf(
        this.#identity,
        account.stableAccountId,
        result,
        'POINT_IN_TIME',
        account.updateTime,
        null,
      ),
    };
  }

  /**
   * One order, by exact identity.
   *
   * Either the venue's order id or our client order id; the venue accepts both together as its
   * own cross-check. There is no "search" and no list: an order is looked up by the identity
   * it was dispatched under, which is the only correlation this product trusts.
   */
  async orderByIdentity(
    identity:
      | { readonly symbol: string; readonly venueOrderId: string }
      | { readonly symbol: string; readonly clientOrderId: string },
    scales: Scales,
  ): Promise<Observation<VenueOrderObservation>> {
    const parameters: Record<string, string> =
      'venueOrderId' in identity
        ? { symbol: identity.symbol, orderId: identity.venueOrderId }
        : { symbol: identity.symbol, origClientOrderId: identity.clientOrderId };
    const provenAccountId = this.#requireProvenAccount('order');
    const result = await this.#transport.read('order', parameters);
    const order = decodeOrder(result.body, scales);
    if (order.symbol !== identity.symbol) {
      // The venue answered about a different market than the one asked about.
      violate('IDENTITY_SCOPE_MISMATCH', 'the order returned is for a different symbol', {
        requested: identity.symbol,
        returned: order.symbol,
      });
    }
    // And about the exact order asked about. Checking only the symbol left the one thing that
    // matters unchecked: this result is the sole evidence for a specific dispatch, and an
    // answer about a different order would be recorded as that dispatch's outcome.
    if ('venueOrderId' in identity && order.venueOrderId !== identity.venueOrderId) {
      violate('IDENTITY_SCOPE_MISMATCH', 'the order returned has a different venue order id', {
        requested: identity.venueOrderId,
        returned: order.venueOrderId,
      });
    }
    if ('clientOrderId' in identity && order.clientOrderId !== identity.clientOrderId) {
      violate('IDENTITY_SCOPE_MISMATCH', 'the order returned has a different client order id', {
        requested: identity.clientOrderId,
        returned: order.clientOrderId ?? 'absent',
      });
    }
    return {
      value: order,
      provenance: provenanceOf(
        this.#identity,
        provenAccountId,
        result,
        'POINT_IN_TIME',
        order.updatedAt,
        null,
      ),
    };
  }

  /**
   * The account-wide open-order scan (ADR-0002 condition C2).
   *
   * Deliberately not scoped to the selected symbol. An order resting on another symbol can
   * consume the shared quote or fee asset, and this scan is the only account-wide discovery
   * Binance Spot offers — `myTrades` requires a symbol, so a *closed* unknown order is not
   * discoverable at all. That asymmetry is why an interrupted window is UNSUPPORTED rather
   * than merely incomplete.
   */
  async openOrdersAccountWide(): Promise<Observation<readonly OpenOrderObservation[]>> {
    const provenAccountId = this.#requireProvenAccount('openOrders');
    const result = await this.#transport.read('openOrders', {});
    const orders = decodeOpenOrders(result.body);
    return {
      value: orders,
      provenance: provenanceOf(this.#identity, provenAccountId, result, 'COMPLETE', null, null),
    };
  }

  /**
   * One page of trades for a symbol, from a cursor.
   *
   * Completeness is decided by the page size, not by whether the page looked plausible: a page
   * that came back full may have been truncated at the limit, so it is `PARTIAL` and carries a
   * cursor. A short page is the end of the range. ADR-0002 condition C3 requires contiguous
   * cursor pagination and forbids assuming trade ids are dense, so nothing here infers a gap
   * from the numeric distance between two ids.
   */
  async tradesFrom(
    symbol: string,
    scales: Scales,
    options: { readonly fromId?: string; readonly limit?: number } = {},
  ): Promise<Observation<TradePage>> {
    const limit = options.limit ?? READ_ENDPOINTS.myTrades.maxLimit ?? 1000;
    const parameters: Record<string, string> = { symbol, limit: String(limit) };
    if (options.fromId !== undefined) parameters['fromId'] = options.fromId;

    const provenAccountId = this.#requireProvenAccount('myTrades');
    const result = await this.#transport.read('myTrades', parameters);
    const trades = decodeTrades(result.body, scales);
    for (const trade of trades) {
      if (trade.symbol !== symbol) {
        violate('IDENTITY_SCOPE_MISMATCH', 'a trade in this page is for a different symbol', {
          requested: symbol,
          returned: trade.symbol,
        });
      }
      // `fromId` is inclusive: "If fromId is set, it will get trades >= that fromId". A row
      // below the cursor is outside the range that was asked for, and letting it through means
      // the cursor would advance past history this page never actually covered.
      if (options.fromId !== undefined && BigInt(trade.venueTradeId) < BigInt(options.fromId)) {
        violate('EVIDENCE_CONTRADICTORY', 'a trade in this page precedes the requested cursor', {
          fromId: options.fromId,
          returned: trade.venueTradeId,
        });
      }
    }
    // More rows than were asked for is not a windfall. The page-size bound is how a full page
    // is distinguished from the end of the range, so an over-long page would make that
    // distinction meaningless and could advance the cursor past unproven history.
    if (trades.length > limit) {
      violate('EVIDENCE_CONTRADICTORY', 'the venue returned more trades than the page limit', {
        limit: String(limit),
        returned: String(trades.length),
      });
    }

    // A full page may have been truncated at the limit, so it is never treated as the end.
    const full = trades.length >= limit;
    const highest = highestTradeId(trades);
    if (full && highest === null) {
      // A full page that yields no cursor cannot be resumed, and silently stopping here would
      // report a truncated history as complete.
      throw schemaUnrecognized('myTrades', 'a full page carried no usable trade id to resume from');
    }
    const nextFromId = full && highest !== null ? (BigInt(highest) + 1n).toString() : null;

    return {
      value: { trades, nextFromId },
      provenance: provenanceOf(
        this.#identity,
        provenAccountId,
        result,
        full ? 'PARTIAL' : 'COMPLETE',
        latestTradeTime(trades),
        nextFromId,
      ),
    };
  }

  /**
   * The account id proven in this session, or a refusal.
   *
   * An authenticated observation stamps an account onto evidence. Taking that from
   * configuration means a credential pointing somewhere else produces facts filed under an
   * account nobody confirmed — the exact failure ADR-0007 section 3 exists to prevent, one
   * layer down.
   */
  #requireProvenAccount(endpoint: string): string {
    if (this.#provenAccountId === null) {
      violate(
        'IDENTITY_UNSTABLE_ACCOUNT',
        'no authenticated account has been proven for this reader yet',
        { endpoint },
      );
    }
    return this.#provenAccountId;
  }

  #assertExpectedAccount(observed: string): void {
    if (observed !== this.#identity.expectedStableAccountId) {
      violate(
        'IDENTITY_UNSTABLE_ACCOUNT',
        'the credential authenticated a different venue account than this pool governs',
        { expected: this.#identity.expectedStableAccountId, observed },
      );
    }
  }
}

/**
 * The largest trade id in a page, compared as an integer.
 *
 * String comparison would order '9' after '10', and the venue does not promise that a page
 * arrives sorted — T-022 requires that reordered provider records produce one effect, so the
 * cursor cannot depend on arrival order.
 */
function highestTradeId(trades: readonly VenueTradeObservation[]): string | null {
  let highest: bigint | null = null;
  for (const trade of trades) {
    const id = BigInt(trade.venueTradeId);
    if (highest === null || id > highest) highest = id;
  }
  return highest === null ? null : highest.toString();
}

function latestTradeTime(trades: readonly VenueTradeObservation[]): number | null {
  let latest: number | null = null;
  for (const trade of trades) {
    if (latest === null || trade.tradedAt > latest) latest = trade.tradedAt;
  }
  return latest;
}
