import { createHash } from 'node:crypto';
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

/**
 * The economic effects the journal booked inside the window, per asset, in atoms.
 *
 * ADR-0002 condition C4 is that the bracketing snapshots differ *by exactly the booked
 * effects*. Without this input the condition cannot be evaluated at all — an earlier version
 * substituted "no filter drift", which is a different fact entirely and let a changed balance
 * with no matching booked effect report COMPLETE.
 *
 * Keyed by asset code, valued in atoms at that asset's declared scale. An asset absent from
 * this map means the journal booked nothing for it, which is a claim about zero, not an
 * absence of information — so an unexplained delta on it is still unexplained.
 */
export type BookedEffects = Readonly<Record<string, bigint>>;

/** One asset whose observed movement does not match what the journal booked. */
export interface BalanceDiscrepancy {
  readonly asset: string;
  /** Observed closing total minus opening total, free plus locked. */
  readonly observedDelta: bigint;
  /** What the journal says it booked. Zero when it booked nothing. */
  readonly bookedDelta: bigint;
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
  /** Assets whose observed movement does not match the booked effects (condition C4). */
  readonly balanceDiscrepancies: readonly BalanceDiscrepancy[];
}

export interface CatchUpOptions {
  readonly scope: IngestScope;
  readonly reader: BinanceSpotReader;
  readonly repository: VenueReadRepository;
  readonly session: SessionEvidence;
  /** Client order ids the journal has marked. Anything else resting is external activity. */
  readonly knownClientOrderIds: ReadonlySet<string>;
  /**
   * The per-asset effects the journal booked inside this window.
   *
   * Required, with no permissive default. A default of "nothing booked" would silently make
   * every window with real activity look unexplained, and a default of "whatever was observed"
   * would make the condition vacuous — which is what it effectively was.
   */
  readonly bookedEffects: BookedEffects;
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
  const { scope, reader, repository, session } = options;
  if (scope.observedSymbols.length === 0) {
    // An empty observed set cannot prove a universe; it asserts that nothing could have moved,
    // which is a claim that needs its own evidence.
    violate('OBSERVATION_COVERAGE_UNSUPPORTED', 'no observed symbol set is configured', {
      poolId: scope.poolId,
    });
  }

  const opening = await reader.accountSnapshot(scope.assetScales);

  // Before anything is written. The snapshot foreign keys catch a bad scope eventually, but
  // "eventually" is after a page of trade evidence has already been written under it — a
  // reader on another epoch could persist its trades under this one and only fail at the
  // final snapshot.
  const scopeCheck = await repository.assertReaderScope({
    workspaceId: scope.workspaceId,
    poolId: scope.poolId,
    scopeEpoch: scope.epoch,
    // The epoch the reader stamps onto its own evidence, which is not necessarily the epoch
    // the writes are scoped by. Both are compared against the one the database says is open.
    readerEpoch: opening.provenance.epoch,
    provenAccountId: opening.value.stableAccountId,
    environment: opening.provenance.environment,
  });
  if (!scopeCheck.ok) {
    violate(
      scopeCheck.reason === 'ENVIRONMENT_MISMATCH'
        ? 'IDENTITY_ENVIRONMENT_MISMATCH'
        : scopeCheck.reason === 'EPOCH_NOT_CURRENT' || scopeCheck.reason === 'NO_OPEN_EPOCH'
          ? 'IDENTITY_EPOCH_MISMATCH'
          : 'IDENTITY_UNSTABLE_ACCOUNT',
      `the reader does not describe this pool: ${scopeCheck.reason}`,
      { poolId: scope.poolId, reason: scopeCheck.reason },
    );
  }

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

  // ADR-0002 condition C4, actually evaluated: the brackets must differ by exactly what the
  // journal booked, across every asset either side mentions. Free and locked are summed
  // because a movement from one to the other is not a change in what the account holds, while
  // a change in the total is.
  const balanceDiscrepancies = reconcileBrackets(
    opening.value,
    closing.value,
    options.bookedEffects,
  );

  const conditions: CoverageConditions = {
    // U: the universe is proven only when every configured symbol was actually enumerated and
    // its backfill completed. A symbol we could not page is a symbol we cannot speak for.
    movementUniverseProven: backfills.every((backfill) => backfill.contiguous),
    streamSessionUninterrupted: session.streamSessionUninterrupted,
    accountWideOpenOrderScanClean: unknownOpenOrders.length === 0,
    observedSymbolBackfillContiguous: backfills.every((backfill) => backfill.contiguous),
    // C4: necessary, never sufficient. Every asset's observed movement equals what the
    // journal booked for it — no unexplained increase, no unexplained decrease, and no asset
    // appearing or vanishing between the brackets without a booking to account for it.
    bracketingSnapshotsAgree: balanceDiscrepancies.length === 0,
    // A filter change means the brackets were taken under different market rules, so the
    // sources they came from are not comparable within one window.
    sourcesFresh: session.sourcesFresh && filterDrift.length === 0,
    allMovementTypesObservable: session.allMovementTypesObservable,
  };

  const assessment = assessCoverage(conditions, {
    assessed: { from: opening.provenance.requestedAt, to: closing.provenance.respondedAt },
    streamGap: session.streamGap,
  });

  // Both brackets and the verdict, in one transaction. Writing them separately leaves a cut
  // with missing snapshots, or snapshots nobody drew a conclusion from, reachable through an
  // ordinary crash.
  await repository.recordAssessedCut({
    workspaceId: scope.workspaceId,
    poolId: scope.poolId,
    epoch: scope.epoch,
    cutId: options.cutId,
    opening: snapshotRecordOf(bracketId(options.cutId, 'open'), opening),
    closing: snapshotRecordOf(bracketId(options.cutId, 'close'), closing),
    assessment,
    observedSymbols: scope.observedSymbols,
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
    balanceDiscrepancies,
  };
}

/**
 * Every asset whose observed movement does not match the booked effects.
 *
 * The union of assets is taken from both brackets and from the booked effects, so an asset
 * that appears only in the closing snapshot, only in the opening one, or only in the journal
 * is still reconciled. Restricting the comparison to assets present in both brackets is how a
 * newly appearing balance goes unnoticed.
 */
function reconcileBrackets(
  opening: AccountSnapshot,
  closing: AccountSnapshot,
  booked: BookedEffects,
): readonly BalanceDiscrepancy[] {
  const totals = (snapshot: AccountSnapshot): Map<string, bigint> => {
    const byAsset = new Map<string, bigint>();
    for (const balance of snapshot.balances) {
      // Free plus locked: moving between them is not a change in what the account holds.
      byAsset.set(
        balance.asset,
        (byAsset.get(balance.asset) ?? 0n) + balance.freeAtoms + balance.lockedAtoms,
      );
    }
    return byAsset;
  };
  const before = totals(opening);
  const after = totals(closing);
  const assets = new Set([...before.keys(), ...after.keys(), ...Object.keys(booked)]);

  const discrepancies: BalanceDiscrepancy[] = [];
  for (const asset of [...assets].sort()) {
    const observedDelta = (after.get(asset) ?? 0n) - (before.get(asset) ?? 0n);
    const bookedDelta = booked[asset] ?? 0n;
    if (observedDelta !== bookedDelta) {
      discrepancies.push({ asset, observedDelta, bookedDelta });
    }
  }
  return discrepancies;
}

/**
 * A bounded, deterministic id for one bracket.
 *
 * `snapshot_id` is capped at 64 characters by its shape CHECK, and `cutId` may itself be 64.
 * Truncating alone was not enough: two different 64-character cut ids sharing a prefix would
 * truncate to the same bracket id and collide, so the long form keeps a digest of the whole
 * cut id, which distinguishes them.
 */
function bracketId(cutId: string, side: 'open' | 'close'): string {
  const suffix = `-${side}`;
  if (cutId.length + suffix.length <= 64) return `${cutId}${suffix}`;
  const digest = createHash('sha256').update(cutId).digest('hex').slice(0, 16);
  // 64 = prefix + '-' + 16 digest characters + suffix.
  return `${cutId.slice(0, 64 - suffix.length - 17)}-${digest}${suffix}`;
}

function snapshotRecordOf(snapshotId: string, observed: Observation<AccountSnapshot>) {
  return {
    snapshotId,
    stableAccountId: observed.value.stableAccountId,
    requestedAt: observed.provenance.requestedAt,
    respondedAt: observed.provenance.respondedAt,
    sourceTime: observed.provenance.sourceTime,
    responseDigest: observed.provenance.responseDigest,
    balances: observed.value.balances.map((balance) => ({
      asset: balance.asset,
      freeAtoms: balance.freeAtoms.toString(),
      lockedAtoms: balance.lockedAtoms.toString(),
    })),
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

    // A terminal page still moves the cursor past the rows it carried. Leaving it where it
    // was makes every restart re-fetch history that is already durable, forever.
    const highest = highestOf(observed.value.trades);
    const nextFromId =
      observed.value.nextFromId ?? (highest === null ? null : (highest + 1n).toString());

    // The page's evidence and the cursor move together, in one transaction. Advancing
    // separately is the shape of bug that loses history silently: the cursor moves, the
    // process dies before the trades are durable, and the next run resumes past a page nothing
    // ever recorded. Neither half is useful without the other.
    const recorded = await repository.recordPageAndAdvance({
      workspaceId: scope.workspaceId,
      poolId: scope.poolId,
      epoch: scope.epoch,
      symbol,
      trades: observed.value.trades.map((trade) => ({
        venueTradeId: trade.venueTradeId,
        payload: {
          symbol: trade.symbol,
          venueTradeId: trade.venueTradeId,
          venueOrderId: trade.venueOrderId,
          baseAtoms: trade.baseAtoms.toString(),
          quoteAtoms: trade.quoteAtoms.toString(),
          commissionAsset: trade.commissionAsset,
          commissionAtoms: trade.commissionAtoms.toString(),
          tradedAt: new Date(trade.tradedAt).toISOString(),
          isBuyer: trade.isBuyer,
          isMaker: trade.isMaker,
        },
      })),
      cursor:
        nextFromId === null
          ? null
          : {
              nextFromId,
              highestTradeId: (BigInt(nextFromId) - 1n).toString(),
              digest: observed.provenance.responseDigest,
            },
    });

    if (!recorded.ok) {
      // Contradicted evidence, or a cursor that will not advance. Neither is a reason to keep
      // paging: the next request would return the same rows, and the contradiction needs an
      // owner rather than another page. The backfill is left not contiguous, which makes the
      // window unprovable — the conservative direction, and visible.
      break;
    }

    if (observed.value.nextFromId === null) {
      // A short page is the end of the range: pagination reached it contiguously.
      if (nextFromId !== null) cursor = nextFromId;
      contiguous = true;
      break;
    }
    cursor = observed.value.nextFromId;
  }
  return { symbol, trades, cursor, contiguous };
}

/** The largest trade id in a page, or null when it carried none. */
function highestOf(trades: readonly VenueTradeObservation[]): bigint | null {
  let highest: bigint | null = null;
  for (const trade of trades) {
    const id = BigInt(trade.venueTradeId);
    if (highest === null || id > highest) highest = id;
  }
  return highest;
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
