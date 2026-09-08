import {
  assessCoverage,
  describeDetection,
  violate,
  type CoverageAssessment,
  type CoverageConditions,
  type Interval,
} from '@capitaldesk/contracts';
import {
  type AccountSnapshot,
  type BinanceSpotReader,
  type Observation,
  type OpenOrderObservation,
  type Scales,
  type SymbolContext,
  type VenueTradeObservation,
} from '@capitaldesk/binance';
import type { TradeCursor, VenueReadRepository } from '@capitaldesk/db';

/**
 * The worker's ingest boundary (prompt 05, task 4).
 *
 * One catch-up: an opening snapshot, contiguous per-symbol trade backfill from the persisted
 * cursors, an account-wide open-order scan, a closing snapshot, then the coverage predicate
 * over what was actually gathered. The result states its confidence and every reason it is not
 * higher.
 *
 * Two things this deliberately does not do.
 *
 * It does not decide that a window is COMPLETE by looking at the data. It gathers evidence,
 * fills in the conditions it can honestly attest, and hands them to `assessCoverage` in
 * `@capitaldesk/contracts` — the same predicate the console and the exports use. A second
 * implementation of that judgement would be a second answer to the question of whether capital
 * may move.
 *
 * And it never treats matching balances as proof. ADR-0002 condition C4 is necessary and never
 * sufficient: offsetting movements leave bracketing snapshots equal, which is precisely the
 * counterexample the amended predicate exists for.
 */

export interface IngestScope {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly epoch: number;
  /**
   * Every symbol that could move a governed asset (ADR-0002 condition U).
   *
   * Owner-visible configuration, not an implementation detail: this is the list that decides
   * whether "one tradable symbol" silently becomes "one observed symbol".
   */
  readonly observedSymbols: readonly string[];
  readonly scales: Readonly<Record<string, Scales>>;
  readonly assetScales: Readonly<Record<string, number>>;
}

/** What the caller can attest that this module cannot observe for itself. */
export interface SessionEvidence {
  /** C1: one uninterrupted stream session spanned the window. */
  readonly streamSessionUninterrupted: boolean;
  /** The interruption inside the window, when there was one. */
  readonly streamGap: Interval | null;
  /** C5: every source used is inside its declared freshness class. */
  readonly sourcesFresh: boolean;
  /**
   * Whether every movement type that could have occurred is observable at all.
   *
   * Deposits, withdrawals and internal transfers are not observable in the v1 testnet surface,
   * so this is normally false and the honest verdict is UNSUPPORTED.
   */
  readonly allMovementTypesObservable: boolean;
}

export interface SymbolBackfill {
  readonly symbol: string;
  readonly trades: readonly VenueTradeObservation[];
  /** The cursor this symbol reached, or null when it never advanced. */
  readonly cursor: string | null;
  /** True when pagination reached the end of the range rather than a page limit. */
  readonly contiguous: boolean;
}

export interface CutResult {
  readonly cutId: string;
  readonly opening: Observation<AccountSnapshot>;
  readonly closing: Observation<AccountSnapshot>;
  readonly openOrders: Observation<readonly OpenOrderObservation[]>;
  readonly backfills: readonly SymbolBackfill[];
  readonly assessment: CoverageAssessment;
  /** The operator-facing statement of what this evidence can speak for. */
  readonly detection: string;
  /** Open orders the journal does not know about (ADR-0002 condition C2). */
  readonly unknownOpenOrders: readonly OpenOrderObservation[];
  /** Filters that changed between the opening and closing reads of a symbol. */
  readonly filterDrift: readonly string[];
}

export interface CatchUpOptions {
  readonly scope: IngestScope;
  readonly reader: BinanceSpotReader;
  readonly repository: VenueReadRepository;
  readonly session: SessionEvidence;
  /** Client order ids the journal has marked. Anything else resting is external activity. */
  readonly knownClientOrderIds: ReadonlySet<string>;
  /** Bounded: a catch-up that pages forever is an outage, not a backfill. */
  readonly maxPagesPerSymbol?: number;
  readonly cutId: string;
}

const DEFAULT_MAX_PAGES = 20;

/**
 * Run one catch-up and assess its coverage.
 *
 * The order is deliberate. The opening snapshot is taken first so that everything read
 * afterwards is bracketed by it; the closing snapshot last so that nothing gathered falls
 * outside the window it claims to describe.
 */
export async function catchUp(options: CatchUpOptions): Promise<CutResult> {
  const { scope, reader, session } = options;
  if (scope.observedSymbols.length === 0) {
    // An empty observed set cannot prove a universe; it asserts that nothing could have moved,
    // which is a claim that needs its own evidence.
    violate('OBSERVATION_COVERAGE_UNSUPPORTED', 'no observed symbol set is configured', {
      poolId: scope.poolId,
    });
  }

  const opening = await reader.accountSnapshot(scope.assetScales);
  const openingContext = await marketContexts(reader, scope);

  const backfills: SymbolBackfill[] = [];
  for (const symbol of scope.observedSymbols) {
    backfills.push(await backfillSymbol(options, symbol));
  }

  const openOrders = await reader.openOrdersAccountWide();
  const closingContext = await marketContexts(reader, scope);
  const closing = await reader.accountSnapshot(scope.assetScales);

  // An order resting on the account that the journal never marked is external activity. It is
  // reported as unexplained rather than attributed: Binance offers no account-wide
  // completed-trade endpoint, so guessing a cause would be inventing one (ADR-0002 section 3).
  const unknownOpenOrders = openOrders.value.filter(
    (order) =>
      order.clientOrderId === null || !options.knownClientOrderIds.has(order.clientOrderId),
  );

  const filterDrift = driftBetween(openingContext, closingContext);

  const conditions: CoverageConditions = {
    // U: the universe is proven only when every configured symbol was actually enumerated and
    // its backfill completed. A symbol we could not page is a symbol we cannot speak for.
    movementUniverseProven: backfills.every((backfill) => backfill.contiguous),
    streamSessionUninterrupted: session.streamSessionUninterrupted,
    accountWideOpenOrderScanClean: unknownOpenOrders.length === 0,
    observedSymbolBackfillContiguous: backfills.every((backfill) => backfill.contiguous),
    // C4: necessary, never sufficient. A filter change during the cut means the two brackets
    // were taken under different market rules, so they cannot be compared as if they were not.
    bracketingSnapshotsAgree: filterDrift.length === 0,
    sourcesFresh: session.sourcesFresh,
    allMovementTypesObservable: session.allMovementTypesObservable,
  };

  const assessment = assessCoverage(conditions, {
    assessed: { from: opening.provenance.requestedAt, to: closing.provenance.respondedAt },
    streamGap: session.streamGap,
  });

  return {
    cutId: options.cutId,
    opening,
    closing,
    openOrders,
    backfills,
    assessment,
    detection: describeDetection(assessment),
    unknownOpenOrders,
    filterDrift,
  };
}

/**
 * Page one symbol from its persisted cursor to the end of the range.
 *
 * Bounded. A catch-up that pages forever is an outage rather than a backfill, and stopping at
 * the bound reports `contiguous: false`, which makes the window unprovable — the conservative
 * direction, and visible rather than silent.
 */
async function backfillSymbol(options: CatchUpOptions, symbol: string): Promise<SymbolBackfill> {
  const { scope, reader, repository } = options;
  const scales = scope.scales[symbol];
  if (scales === undefined) {
    violate(
      'OBSERVATION_COVERAGE_UNSUPPORTED',
      `no declared scales for observed symbol ${symbol}`,
      {
        symbol,
      },
    );
  }

  const stored: TradeCursor | null = await repository.cursor({
    workspaceId: scope.workspaceId,
    poolId: scope.poolId,
    epoch: scope.epoch,
    symbol,
  });

  const trades: VenueTradeObservation[] = [];
  let cursor = stored?.nextFromId ?? null;
  let contiguous = false;
  const maxPages = options.maxPagesPerSymbol ?? DEFAULT_MAX_PAGES;

  for (let page = 0; page < maxPages; page += 1) {
    const observed = await reader.tradesFrom(symbol, scales, {
      ...(cursor === null ? {} : { fromId: cursor }),
    });
    trades.push(...observed.value.trades);

    if (observed.value.nextFromId !== null) {
      // The cursor is persisted per page, not once at the end. A crash between pages then
      // resumes where it stopped instead of re-reading a range whose evidence it discarded.
      const advanced = await repository.advance(
        { workspaceId: scope.workspaceId, poolId: scope.poolId, epoch: scope.epoch, symbol },
        {
          nextFromId: observed.value.nextFromId,
          highestTradeId: (BigInt(observed.value.nextFromId) - 1n).toString(),
          digest: observed.provenance.responseDigest,
        },
      );
      if (!advanced.ok) {
        // A cursor that will not advance is not a reason to keep paging: the next request
        // would return the same rows forever.
        break;
      }
      cursor = observed.value.nextFromId;
      continue;
    }

    // A short page is the end of the range: pagination reached it contiguously.
    contiguous = true;
    break;
  }

  return { symbol, trades, cursor, contiguous };
}

async function marketContexts(
  reader: BinanceSpotReader,
  scope: IngestScope,
): Promise<Map<string, SymbolContext>> {
  const contexts = new Map<string, SymbolContext>();
  for (const symbol of scope.observedSymbols) {
    contexts.set(symbol, (await reader.marketContext(symbol)).value);
  }
  return contexts;
}

/**
 * Filters that changed between the opening and closing reads.
 *
 * A cut taken across a filter change compared two brackets under different market rules. The
 * TDD lists a scale change alongside an external trade as something that quarantines the pool,
 * so it is surfaced rather than absorbed.
 */
function driftBetween(
  opening: ReadonlyMap<string, SymbolContext>,
  closing: ReadonlyMap<string, SymbolContext>,
): readonly string[] {
  const drift: string[] = [];
  for (const [symbol, before] of opening) {
    const after = closing.get(symbol);
    if (after === undefined) {
      drift.push(`${symbol}: the symbol disappeared from exchange information during the cut`);
      continue;
    }
    if (before.status !== after.status) {
      drift.push(`${symbol}: trading status changed from ${before.status} to ${after.status}`);
    }
    if (
      before.baseAssetPrecision !== after.baseAssetPrecision ||
      before.quoteAssetPrecision !== after.quoteAssetPrecision
    ) {
      // A scale change silently rescales every quantity read on either side of it.
      drift.push(`${symbol}: asset precision changed during the cut`);
    }
    if (JSON.stringify(before.rawFilters) !== JSON.stringify(after.rawFilters)) {
      drift.push(`${symbol}: exchange filters changed during the cut`);
    }
  }
  return drift;
}
