import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { BinanceSpotReader, ReadOnlyTransport, readOrigin } from '@capitaldesk/binance';
import { VenueReadRepository, loadMigrations, migrate } from '@capitaldesk/db';
import { catchUp, type BookedEffects, type SessionEvidence } from './ingest.js';

const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];
const WORKSPACE = 'ws-ingest';
const POOL_ID = 'pool-1';
// The pool's environment must match the reader's, which is what the scope check compares.
const ACCOUNT_KEY = {
  venue: 'binance-spot',
  environment: 'testnet',
  stableAccountId: '354937868',
};

/**
 * A schema for this suite, migrated from the shipped files.
 *
 * The journal package's own harness is test-only and deliberately not part of the published
 * surface of `@capitaldesk/db`; exporting it to reach it here would put test scaffolding into
 * a production package. The migrator is exported, so this builds the same schema from the same
 * migrations.
 */
class IngestHarness {
  readonly schema = `ingest_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  pool!: Pool;
  admin!: Client;

  async open(): Promise<void> {
    this.admin = new Client({ connectionString: DATABASE_URL });
    await this.admin.connect();
    await this.admin.query(`SET lock_timeout = '5s'`);
    await this.admin.query(`SET statement_timeout = '20s'`);
    this.pool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${this.schema}`,
      max: 4,
    });
  }

  async reset(): Promise<void> {
    const migrationsDir = path.join(
      path.dirname(createRequire(import.meta.url).resolve('@capitaldesk/db')),
      '..',
      'migrations',
    );
    await this.admin.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
    await this.admin.query(`CREATE SCHEMA ${this.schema}`);
    await this.admin.query(`SET search_path TO ${this.schema}`);
    await migrate(this.admin, await loadMigrations(migrationsDir), {
      appliedBy: 'vitest',
      buildId: 'ingest-test',
    });
    await this.admin.query(
      `INSERT INTO workspaces (workspace_id, display_name) VALUES ($1, 'Ingest')`,
      [WORKSPACE],
    );
    await this.admin.query(
      `INSERT INTO venue_accounts (venue, environment, stable_account_id) VALUES ($1,$2,$3)`,
      [ACCOUNT_KEY.venue, ACCOUNT_KEY.environment, ACCOUNT_KEY.stableAccountId],
    );
    await this.admin.query(
      `INSERT INTO pools (workspace_id, pool_id, venue, environment, stable_account_id, state)
       VALUES ($1,$2,$3,$4,$5,'READY')`,
      [WORKSPACE, POOL_ID, ACCOUNT_KEY.venue, ACCOUNT_KEY.environment, ACCOUNT_KEY.stableAccountId],
    );
    await this.admin.query(
      `INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ($1,$2,1)`,
      [WORKSPACE, POOL_ID],
    );
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => undefined);
    await this.admin.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`).catch(() => undefined);
    await this.admin.end().catch(() => undefined);
  }
}

/**
 * The worker ingest boundary, against a scripted venue and real PostgreSQL.
 *
 * These are the account-observation scenarios: bracketed cuts, per-symbol backfill from
 * persisted cursors, the account-wide open-order scan, filter drift during a cut, and restart
 * from a stored cursor. The coverage verdict comes from the shared predicate, never from a
 * second judgement made here.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const TESTNET = readOrigin('https://testnet.binance.vision');
const SCALES = { BTCUSDT: { base: 8, quote: 8, commission: { BNB: 8, USDT: 8 } } };
const ASSET_SCALES = { BTC: 8, USDT: 8 };

const FULLY_OBSERVABLE: SessionEvidence = {
  streamSessionUninterrupted: true,
  streamGap: null,
  sourcesFresh: true,
  allMovementTypesObservable: true,
};

function symbolInfo(overrides: Record<string, unknown> = {}): unknown {
  return {
    serverTime: 1_788_867_332_000,
    symbols: [
      {
        symbol: 'BTCUSDT',
        status: 'TRADING',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        baseAssetPrecision: 8,
        quoteAssetPrecision: 8,
        orderTypes: ['LIMIT'],
        filters: [
          {
            filterType: 'LOT_SIZE',
            minQty: '0.00001000',
            maxQty: '9000.00000000',
            stepSize: '0.00001000',
          },
        ],
        ...overrides,
      },
    ],
  };
}

const ACCOUNT = {
  accountType: 'SPOT',
  updateTime: 1_788_867_356_144,
  balances: [{ asset: 'USDT', free: '1000.00000000', locked: '0.00000000' }],
  permissions: ['SPOT'],
  uid: 354_937_868,
};

function trade(id: number): Record<string, unknown> {
  return {
    symbol: 'BTCUSDT',
    id,
    orderId: 100_234,
    price: '30000.00000000',
    qty: '0.00050000',
    quoteQty: '15.00000000',
    commission: '0.00001500',
    commissionAsset: 'BNB',
    time: 1_788_867_000_000 + id,
    isBuyer: true,
    isMaker: false,
  };
}

describeIfDatabase('worker ingest catch-up', () => {
  const harness = new IngestHarness();
  let repository: VenueReadRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    repository = new VenueReadRepository(harness.pool);
  });

  /** A scripted venue whose answers may vary per call. */
  function reader(script: {
    exchangeInfo?: (call: number) => unknown;
    account?: (call: number) => unknown;
    openOrders?: () => unknown;
    myTrades?: (fromId: string | null) => unknown;
  }): { reader: BinanceSpotReader; calls: URL[] } {
    const calls: URL[] = [];
    let infoCall = 0;
    let accountCall = 0;
    const fetchImpl = vi.fn((request: Request) => {
      const url = new URL(request.url);
      calls.push(url);
      const body = (() => {
        switch (url.pathname) {
          case '/api/v3/exchangeInfo':
            return (script.exchangeInfo ?? (() => symbolInfo()))(infoCall++);
          case '/api/v3/account':
            return (script.account ?? (() => ACCOUNT))(accountCall++);
          case '/api/v3/openOrders':
            return (script.openOrders ?? (() => []))();
          case '/api/v3/myTrades':
            return (script.myTrades ?? (() => []))(url.searchParams.get('fromId'));
          default:
            throw new Error(`unscripted ${url.pathname}`);
        }
      })();
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;

    let tick = 0;
    return {
      reader: new BinanceSpotReader({
        deployment: 'testnet',
        transport: new ReadOnlyTransport({
          deployment: 'testnet',
          origin: TESTNET,
          fetch: fetchImpl,
          credential: {
            credentialClass: 'VENUE_READ',
            alias: 'venue-read-fixture',
            authorize: (query) => {
              const signed = new URLSearchParams(query);
              signed.set('signature', 'FIXTURE-SIGNATURE-VALUE');
              return { headers: { 'X-MBX-APIKEY': 'FIXTURE-API-KEY-VALUE' }, signedQuery: signed };
            },
          },
          now: () => new Date(Date.parse('2026-09-08T12:00:00.000Z') + tick++ * 10),
        }),
        identity: { environment: 'testnet', expectedStableAccountId: '354937868', epoch: 1 },
      }),
      calls,
    };
  }

  function run(
    built: { reader: BinanceSpotReader },
    session: SessionEvidence = FULLY_OBSERVABLE,
    known: ReadonlySet<string> = new Set(),
    bookedEffects: BookedEffects = {},
  ): ReturnType<typeof catchUp> {
    return catchUp({
      scope: {
        workspaceId: WORKSPACE,
        poolId: POOL_ID,
        epoch: 1,
        observedSymbols: ['BTCUSDT'],
        scales: SCALES,
        assetScales: ASSET_SCALES,
      },
      reader: built.reader,
      repository,
      session,
      knownClientOrderIds: known,
      bookedEffects,
      cutId: 'cut-1',
    });
  }

  it('brackets the cut with snapshots and reports COMPLETE when every condition holds', async () => {
    const result = await run(reader({}));
    expect(result.assessment.state).toBe('COMPLETE');
    expect(result.assessment.unmet).toEqual([]);
    expect(result.detection).toContain('enumerable and was enumerated');
    // The opening snapshot precedes everything gathered, and the closing one follows it.
    expect(
      Date.parse(result.opening.provenance.requestedAt) <
        Date.parse(result.closing.provenance.respondedAt),
    ).toBe(true);
  });

  /** ADR-0002 section 4: unobservable movement types make the window UNSUPPORTED. */
  it('reports UNSUPPORTED when a movement type is not observable at all', async () => {
    const result = await run(reader({}), {
      ...FULLY_OBSERVABLE,
      allMovementTypesObservable: false,
    });
    expect(result.assessment.state).toBe('UNSUPPORTED');
    expect(result.assessment.unmet).toContain(
      'a possible movement type is not observable on this account',
    );
    expect(result.detection).not.toContain('enumerable and was enumerated');
  });

  it('reports UNSUPPORTED for an interrupted session, not merely INCOMPLETE', async () => {
    // The evidence needed to close it cannot be fetched at all: myTrades requires a symbol, so
    // the set of symbols that traded during the gap is not discoverable afterwards.
    const result = await run(reader({}), {
      streamSessionUninterrupted: false,
      streamGap: { from: '2026-09-08T12:00:00.005Z', to: '2026-09-08T12:00:00.006Z' },
      sourcesFresh: true,
      allMovementTypesObservable: true,
    });
    expect(result.assessment.state).toBe('UNSUPPORTED');
  });

  /** T-041: an order resting on another symbol can consume the shared quote or fee asset. */
  it('detects an unknown resting order on a symbol outside the observed set', async () => {
    const result = await run(
      reader({
        openOrders: () => [
          {
            symbol: 'ETHUSDT',
            orderId: 7,
            clientOrderId: 'not-ours',
            status: 'NEW',
            updateTime: 1,
          },
        ],
      }),
    );
    expect(result.unknownOpenOrders.map((order) => order.symbol)).toEqual(['ETHUSDT']);
    expect(result.assessment.state).not.toBe('COMPLETE');
    expect(result.assessment.unmet).toContain(
      'account-wide open-order scan found an order unknown to the journal',
    );
  });

  it('does not flag a resting order the journal knows about', async () => {
    const result = await run(
      reader({
        openOrders: () => [
          { symbol: 'BTCUSDT', orderId: 7, clientOrderId: 'ours-1', status: 'NEW', updateTime: 1 },
        ],
      }),
      FULLY_OBSERVABLE,
      new Set(['ours-1']),
    );
    expect(result.unknownOpenOrders).toEqual([]);
    expect(result.assessment.state).toBe('COMPLETE');
  });

  it('treats a resting order with no client id as unknown', async () => {
    // An order we never marked has no correlation to us. Absent is not "ours".
    const result = await run(
      reader({
        openOrders: () => [{ symbol: 'BTCUSDT', orderId: 7, status: 'NEW', updateTime: 1 }],
      }),
      FULLY_OBSERVABLE,
      new Set(['ours-1']),
    );
    expect(result.unknownOpenOrders).toHaveLength(1);
  });

  /** T-034: completeness comes from contiguous pagination, never from one good page. */
  describe('per-symbol backfill', () => {
    it('pages to the end and persists the cursor as it goes', async () => {
      const pages: Record<string, unknown[]> = {
        null: Array.from({ length: 1000 }, (_unused, index) => trade(index + 1)),
        '1001': [trade(1001), trade(1002)],
      };
      const built = reader({ myTrades: (fromId) => pages[String(fromId)] ?? [] });
      const result = await run(built);

      expect(result.backfills[0]?.trades).toHaveLength(1002);
      expect(result.backfills[0]?.contiguous).toBe(true);
      expect(result.assessment.state).toBe('COMPLETE');
      // Persisted between pages, so a crash resumes rather than re-reading — and past the
      // final short page's rows too, or every restart would re-fetch history already durable.
      const stored = await repository.cursor({
        workspaceId: WORKSPACE,
        poolId: POOL_ID,
        epoch: 1,
        symbol: 'BTCUSDT',
      });
      expect(stored?.nextFromId).toBe('1003');
    });

    it('resumes from a persisted cursor after a restart', async () => {
      await repository.advance(
        { workspaceId: WORKSPACE, poolId: POOL_ID, epoch: 1, symbol: 'BTCUSDT' },
        { nextFromId: '500', highestTradeId: '499', digest: `sha256:${'b'.repeat(64)}` },
      );
      const seen: (string | null)[] = [];
      const built = reader({
        myTrades: (fromId) => {
          seen.push(fromId);
          return [];
        },
      });
      await run(built);
      // It asked from where it left off, not from the beginning.
      expect(seen).toEqual(['500']);
    });

    it('stops at the page bound and reports the window as unprovable', async () => {
      // A catch-up that pages forever is an outage. Stopping is visible, not silent.
      let id = 0;
      const built = reader({
        myTrades: () => Array.from({ length: 1000 }, () => trade(++id)),
      });
      const result = await catchUp({
        scope: {
          workspaceId: WORKSPACE,
          poolId: POOL_ID,
          epoch: 1,
          observedSymbols: ['BTCUSDT'],
          scales: SCALES,
          assetScales: ASSET_SCALES,
        },
        reader: built.reader,
        repository,
        session: FULLY_OBSERVABLE,
        knownClientOrderIds: new Set(),
        bookedEffects: {},
        maxPagesPerSymbol: 2,
        cutId: 'cut-bounded',
      });
      expect(result.backfills[0]?.contiguous).toBe(false);
      expect(result.assessment.state).toBe('UNSUPPORTED');
      expect(result.assessment.unmet).toContain(
        'observed-symbol trade backfill did not page contiguously to an already-booked trade',
      );
    });
  });

  /** A cut taken across a filter change compared two brackets under different market rules. */
  describe('filter drift during a cut', () => {
    it('detects a changed filter and refuses to call the cut complete', async () => {
      const built = reader({
        exchangeInfo: (call) =>
          call === 0
            ? symbolInfo()
            : symbolInfo({
                filters: [
                  {
                    filterType: 'LOT_SIZE',
                    minQty: '0.00002000',
                    maxQty: '9000.00000000',
                    stepSize: '0.00001000',
                  },
                ],
              }),
      });
      const result = await run(built);
      expect(result.filterDrift).toEqual(['BTCUSDT: exchange filters changed during the cut']);
      expect(result.assessment.state).not.toBe('COMPLETE');
    });

    it('detects a scale change, which silently rescales every quantity read', async () => {
      // Quantities that fit both scales, so the case exercises the drift check rather than
      // the decoder's precision refusal.
      const coarse = [
        {
          filterType: 'LOT_SIZE',
          minQty: '0.001000',
          maxQty: '9000.000000',
          stepSize: '0.001000',
        },
      ];
      const built = reader({
        exchangeInfo: (call) =>
          call === 0
            ? symbolInfo({ filters: coarse })
            : symbolInfo({ filters: coarse, baseAssetPrecision: 6 }),
      });
      const result = await run(built);
      expect(result.filterDrift).toContain('BTCUSDT: asset precision changed during the cut');
    });

    it('detects a trading-status change', async () => {
      const built = reader({
        exchangeInfo: (call) => (call === 0 ? symbolInfo() : symbolInfo({ status: 'HALT' })),
      });
      const result = await run(built);
      expect(result.filterDrift).toContain('BTCUSDT: trading status changed from TRADING to HALT');
    });
  });

  it('refuses to run with no observed symbol set, rather than proving an empty universe', async () => {
    await expect(
      catchUp({
        scope: {
          workspaceId: WORKSPACE,
          poolId: POOL_ID,
          epoch: 1,
          observedSymbols: [],
          scales: SCALES,
          assetScales: ASSET_SCALES,
        },
        reader: reader({}).reader,
        repository,
        session: FULLY_OBSERVABLE,
        knownClientOrderIds: new Set(),
        bookedEffects: {},
        cutId: 'cut-empty',
      }),
    ).rejects.toThrow(/observed symbol set/);
  });

  it('refuses an observed symbol whose scales were never declared', async () => {
    await expect(
      catchUp({
        scope: {
          workspaceId: WORKSPACE,
          poolId: POOL_ID,
          epoch: 1,
          observedSymbols: ['BTCUSDT', 'ETHUSDT'],
          scales: SCALES,
          assetScales: ASSET_SCALES,
        },
        reader: reader({}).reader,
        repository,
        session: FULLY_OBSERVABLE,
        knownClientOrderIds: new Set(),
        bookedEffects: {},
        cutId: 'cut-unscaled',
      }),
    ).rejects.toThrow(/ETHUSDT/);
  });

  /**
   * ADR-0002 condition C4, actually evaluated.
   *
   * The earlier version set this condition from filter drift alone, so a changed balance with
   * no matching booked effect reported COMPLETE. These cases pin the comparison itself.
   */
  describe('bracketing balances against booked effects', () => {
    function accountWith(free: string): unknown {
      return {
        ...ACCOUNT,
        balances: [{ asset: 'USDT', free, locked: '0.00000000' }],
      };
    }

    it('reports COMPLETE when the observed movement equals what the journal booked', async () => {
      const built = reader({
        account: (call) =>
          call === 0 ? accountWith('1000.00000000') : accountWith('985.00000000'),
      });
      const result = await run(built, FULLY_OBSERVABLE, new Set(), { USDT: -1_500_000_000n });
      expect(result.balanceDiscrepancies).toEqual([]);
      expect(result.assessment.state).toBe('COMPLETE');
    });

    it('reports a zero delta against a zero booking as agreeing', async () => {
      const built = reader({ account: () => accountWith('1000.00000000') });
      const result = await run(built, FULLY_OBSERVABLE, new Set(), {});
      expect(result.balanceDiscrepancies).toEqual([]);
      expect(result.assessment.state).toBe('COMPLETE');
    });

    it('detects an unexplained increase', async () => {
      const built = reader({
        account: (call) =>
          call === 0 ? accountWith('1000.00000000') : accountWith('1100.00000000'),
      });
      const result = await run(built, FULLY_OBSERVABLE, new Set(), {});
      expect(result.balanceDiscrepancies).toEqual([
        { asset: 'USDT', observedDelta: 10_000_000_000n, bookedDelta: 0n },
      ]);
      expect(result.assessment.state).not.toBe('COMPLETE');
      expect(result.assessment.unmet).toContain(
        'bracketing balance snapshots disagree with booked effects',
      );
    });

    it('detects an unexplained decrease', async () => {
      const built = reader({
        account: (call) =>
          call === 0 ? accountWith('1000.00000000') : accountWith('900.00000000'),
      });
      const result = await run(built, FULLY_OBSERVABLE, new Set(), {});
      expect(result.balanceDiscrepancies[0]?.observedDelta).toBe(-10_000_000_000n);
      expect(result.assessment.state).not.toBe('COMPLETE');
    });

    it('detects a booked effect with no matching observed movement', async () => {
      // The other direction: the journal says capital moved and the account disagrees.
      const built = reader({ account: () => accountWith('1000.00000000') });
      const result = await run(built, FULLY_OBSERVABLE, new Set(), { USDT: -1_500_000_000n });
      expect(result.balanceDiscrepancies).toEqual([
        { asset: 'USDT', observedDelta: 0n, bookedDelta: -1_500_000_000n },
      ]);
      expect(result.assessment.state).not.toBe('COMPLETE');
    });

    it('detects an asset that appears only in the closing bracket', async () => {
      // Comparing only assets present in both brackets is how a newly appearing balance goes
      // unnoticed.
      const built = reader({
        account: (call) =>
          call === 0
            ? { ...ACCOUNT, balances: [] }
            : { ...ACCOUNT, balances: [{ asset: 'BTC', free: '0.50000000', locked: '0' }] },
      });
      const result = await run(built, FULLY_OBSERVABLE, new Set(), {});
      expect(result.balanceDiscrepancies).toEqual([
        { asset: 'BTC', observedDelta: 50_000_000n, bookedDelta: 0n },
      ]);
    });

    it('detects an asset that vanishes between the brackets', async () => {
      const built = reader({
        account: (call) =>
          call === 0
            ? { ...ACCOUNT, balances: [{ asset: 'BTC', free: '0.50000000', locked: '0' }] }
            : { ...ACCOUNT, balances: [] },
      });
      const result = await run(built, FULLY_OBSERVABLE, new Set(), {});
      expect(result.balanceDiscrepancies).toEqual([
        { asset: 'BTC', observedDelta: -50_000_000n, bookedDelta: 0n },
      ]);
    });

    it('treats a move between free and locked as no change in what is held', async () => {
      const built = reader({
        account: (call) =>
          call === 0
            ? { ...ACCOUNT, balances: [{ asset: 'USDT', free: '1000.00000000', locked: '0' }] }
            : {
                ...ACCOUNT,
                balances: [{ asset: 'USDT', free: '900.00000000', locked: '100.00000000' }],
              },
      });
      const result = await run(built, FULLY_OBSERVABLE, new Set(), {});
      expect(result.balanceDiscrepancies).toEqual([]);
    });

    it('does not let equal balances establish any other condition', async () => {
      // C4 is necessary and never sufficient. Equal brackets with an unknown resting order is
      // still not a complete window.
      const built = reader({
        account: () => accountWith('1000.00000000'),
        openOrders: () => [
          {
            symbol: 'ETHUSDT',
            orderId: 7,
            clientOrderId: 'not-ours',
            status: 'NEW',
            updateTime: 1,
          },
        ],
      });
      const result = await run(built, FULLY_OBSERVABLE, new Set(), {});
      expect(result.balanceDiscrepancies).toEqual([]);
      expect(result.assessment.state).not.toBe('COMPLETE');
      expect(result.assessment.unmet).toContain(
        'account-wide open-order scan found an order unknown to the journal',
      );
    });
  });

  /**
   * The pre-write scope check. Every later write is scoped by workspace, pool and epoch, and
   * the snapshot foreign keys catch a bad scope eventually — but "eventually" is after a page
   * of trade evidence has already been written under it.
   */
  describe('reader scope is bound to the pool before anything is written', () => {
    it('refuses a scope epoch that is not the pool’s open epoch, writing nothing', async () => {
      // A reader on another epoch could otherwise persist its trades under this one and only
      // fail at the final snapshot.
      const built = reader({ myTrades: () => [trade(1), trade(2)] });
      await expect(
        catchUp({
          scope: {
            workspaceId: WORKSPACE,
            poolId: POOL_ID,
            epoch: 99,
            observedSymbols: ['BTCUSDT'],
            scales: SCALES,
            assetScales: ASSET_SCALES,
          },
          reader: built.reader,
          repository,
          session: FULLY_OBSERVABLE,
          knownClientOrderIds: new Set(),
          bookedEffects: {},
          cutId: 'cut-wrong-epoch',
        }),
      ).rejects.toThrow(/EPOCH_NOT_CURRENT/);

      expect((await harness.admin.query('SELECT 1 FROM raw_observations')).rowCount).toBe(0);
      expect((await harness.admin.query('SELECT 1 FROM venue_trade_cursors')).rowCount).toBe(0);
      expect((await harness.admin.query('SELECT 1 FROM venue_account_snapshots')).rowCount).toBe(0);
    });

    it('refuses a pool governed by a different account, writing nothing', async () => {
      await harness.admin.query(
        `INSERT INTO venue_accounts (venue, environment, stable_account_id)
         VALUES ('binance-spot', 'testnet', 'another-account')`,
      );
      await harness.admin.query(
        `UPDATE pools SET stable_account_id = 'another-account' WHERE pool_id = $1`,
        [POOL_ID],
      );
      const built = reader({ myTrades: () => [trade(1)] });
      await expect(run(built)).rejects.toThrow(/ACCOUNT_MISMATCH/);
      expect((await harness.admin.query('SELECT 1 FROM raw_observations')).rowCount).toBe(0);
      expect((await harness.admin.query('SELECT 1 FROM venue_trade_cursors')).rowCount).toBe(0);
    });

    it('refuses a pool whose epoch has been closed by a reset, writing nothing', async () => {
      await harness.admin.query(
        `UPDATE baseline_epochs SET closed_at = now(), closed_reason = 'reset'
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = 1`,
        [WORKSPACE, POOL_ID],
      );
      const built = reader({ myTrades: () => [trade(1)] });
      await expect(run(built)).rejects.toThrow(/NO_OPEN_EPOCH/);
      expect((await harness.admin.query('SELECT 1 FROM raw_observations')).rowCount).toBe(0);
    });
  });

  describe('durability', () => {
    it('persists both brackets and the assessed cut itself', async () => {
      // Previously the test recorded these by hand after catchUp returned, so it proved the
      // repository worked rather than that catchUp used it.
      const result = await run(
        reader({
          openOrders: () => [
            {
              symbol: 'ETHUSDT',
              orderId: 7,
              clientOrderId: 'not-ours',
              status: 'NEW',
              updateTime: 1,
            },
          ],
        }),
      );

      const cuts = await harness.admin.query<{
        cut_id: string;
        coverage_state: string;
        unmet: string[];
        opening_snapshot_id: string;
        closing_snapshot_id: string;
      }>(
        'SELECT cut_id, coverage_state, unmet, opening_snapshot_id, closing_snapshot_id FROM venue_observation_cuts',
      );
      expect(cuts.rows[0]?.cut_id).toBe('cut-1');
      expect(cuts.rows[0]?.coverage_state).toBe(result.assessment.state);
      expect(cuts.rows[0]?.unmet).toEqual([...result.assessment.unmet]);
      expect(cuts.rows[0]?.opening_snapshot_id).toBe('cut-1-open');

      const snapshots = await harness.admin.query<{ snapshot_id: string; response_digest: string }>(
        'SELECT snapshot_id, response_digest FROM venue_account_snapshots ORDER BY snapshot_id',
      );
      expect(snapshots.rows.map((row) => row.snapshot_id)).toEqual(['cut-1-close', 'cut-1-open']);
      expect(snapshots.rows[1]?.response_digest).toBe(result.opening.provenance.responseDigest);
    });

    it('records the page evidence in the same transaction as the cursor', async () => {
      // Advancing separately loses history silently: the cursor moves, the process dies before
      // the trades are durable, and the next run resumes past a page nothing recorded.
      const pages: Record<string, unknown[]> = {
        null: Array.from({ length: 1000 }, (_unused, index) => trade(index + 1)),
        '1001': [trade(1001)],
      };
      await run(reader({ myTrades: (fromId) => pages[String(fromId)] ?? [] }));

      const observations = await harness.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM raw_observations WHERE kind = 'venue_trade'`,
      );
      expect(observations.rows[0]?.count).toBe('1001');
      const cursor = await repository.cursor({
        workspaceId: WORKSPACE,
        poolId: POOL_ID,
        epoch: 1,
        symbol: 'BTCUSDT',
      });
      expect(cursor?.nextFromId).toBe('1002');
    });

    it('leaves no cursor advance behind when the page evidence cannot be written', async () => {
      // The rollback direction: a duplicate observation id is refused, and the cursor that
      // would have moved with it does not.
      const built = reader({
        myTrades: () => Array.from({ length: 1000 }, (_unused, index) => trade(index + 1)),
      });
      await harness.admin.query(
        `INSERT INTO raw_observations
           (workspace_id, pool_id, epoch, observation_id, source, kind, source_ref, payload, payload_digest)
         VALUES ($1, $2, 1, 'trade-BTCUSDT-1', 'operator', 'venue_trade', 'conflicting', '{}'::jsonb, 'd')`,
        [WORKSPACE, POOL_ID],
      );
      await expect(run(built)).rejects.toBeTruthy();
      const cursor = await repository.cursor({
        workspaceId: WORKSPACE,
        poolId: POOL_ID,
        epoch: 1,
        symbol: 'BTCUSDT',
      });
      expect(cursor).toBeNull();
    });
  });
});
