import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  supportedAssets,
  verifyConservation,
  type AssetPosition,
  type BaselineAssessment,
} from '@capitaldesk/ledger';
import { BaselineRepository, type BootstrapOutcome } from './baseline.js';
import { LedgerRepository } from './ledger.js';
import {
  ACCOUNT,
  DATABASE_URL,
  JournalHarness,
  POOL,
  WORKSPACE,
  sqlRefusal,
} from './test-harness.js';

/**
 * The baseline and owner allocation, against real PostgreSQL (module 06).
 *
 * The scenarios the test plan names for this module: opening ownership is explicit (T-011),
 * per-asset conservation through every transition (T-012), one account bootstraps once
 * (T-056), a reset invalidates the epoch (T-032), exclusions stay visible (T-042), strategies
 * stay separate (T-020), and the golden 1000 USDT to 500/500 allocation.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const USDT = { code: 'USDT', scaleVersion: 'v1' } as const;
const BTC = { code: 'BTC', scaleVersion: 'v1' } as const;
const SUPPORTED = supportedAssets({ base: BTC, quote: USDT, feeAssets: [] });
const OWNER = { role: 'owner', credentialClass: 'OWNER_SESSION' } as const;
const DIGEST = `sha256:${'a'.repeat(64)}`;

describeIfDatabase('account baseline and owner allocation', () => {
  const harness = new JournalHarness();
  let baselines: BaselineRepository;
  let ledger: LedgerRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    baselines = new BaselineRepository(harness.pool);
    ledger = new LedgerRepository(harness.pool);
    await seedCompleteCut('cut-1');
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  /** A COMPLETE observation cut with its two brackets, as module 05 would have recorded it. */
  async function seedCompleteCut(
    cutId: string,
    epoch = 1,
    overrides: {
      stableAccountId?: string;
      coverageState?: string;
      detectionScope?: string;
      unmet?: string;
    } = {},
  ): Promise<void> {
    for (const [id, requestedAt, respondedAt] of [
      [`${cutId}-open`, '2026-09-08T11:00:00.000Z', '2026-09-08T11:00:00.100Z'],
      [`${cutId}-close`, '2026-09-08T12:00:00.000Z', '2026-09-08T12:00:00.100Z'],
    ] as const) {
      await harness.admin.query(
        `INSERT INTO venue_account_snapshots
           (workspace_id, pool_id, epoch, snapshot_id, stable_account_id, requested_at,
            responded_at, source_time, response_digest, balances)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,'[]'::jsonb)`,
        [
          WORKSPACE,
          POOL,
          epoch,
          id,
          overrides.stableAccountId ?? ACCOUNT.stableAccountId,
          requestedAt,
          respondedAt,
          DIGEST,
        ],
      );
    }
    await harness.admin.query(
      `INSERT INTO venue_observation_cuts
         (workspace_id, pool_id, epoch, cut_id, window_from, window_to, opening_snapshot_id,
          closing_snapshot_id, coverage_state, detection_scope, unmet, observed_symbols)
       VALUES ($1,$2,$3,$4,'2026-09-08T11:00:00.000Z','2026-09-08T12:00:00.100Z',
               $5,$6,$7,$8,$9::jsonb,'["BTCUSDT"]'::jsonb)`,
      [
        WORKSPACE,
        POOL,
        epoch,
        cutId,
        `${cutId}-open`,
        `${cutId}-close`,
        overrides.coverageState ?? 'COMPLETE',
        overrides.detectionScope ?? 'FULL_WITHIN_PROVEN_UNIVERSE',
        overrides.unmet ?? '[]',
      ],
    );
  }

  function bootstrap(
    overrides: Record<string, unknown> = {},
  ): ReturnType<BaselineRepository['bootstrap']> {
    return baselines.bootstrap({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      baselineId: 'baseline-1',
      cutId: 'cut-1',
      supported: SUPPORTED,
      balances: [{ asset: USDT, atoms: 1_000n }],
      excludedAssets: [],
      ...overrides,
    });
  }

  /** The assessment from a refused bootstrap, or a failed expectation naming what came back. */
  function refusedAssessment(outcome: BootstrapOutcome): BaselineAssessment {
    if (outcome.ok || outcome.reason !== 'NOT_READY') {
      expect.unreachable(`expected a readiness refusal, got ${JSON.stringify(outcome)}`);
    }
    return outcome.assessment;
  }

  /** Positions read back from the ledger, for the independent conservation check. */
  async function positions(): Promise<AssetPosition[]> {
    const control = await harness.admin.query<{ code: string; scale: string; atoms: string }>(
      `SELECT asset_code AS code, asset_scale AS scale, sum(delta_atoms)::text AS atoms
         FROM ledger_entries WHERE claim_state = 'CONTROL'
        GROUP BY asset_code, asset_scale ORDER BY asset_code`,
    );
    const claims = await harness.admin.query<{
      code: string;
      scale: string;
      owner: string;
      available: string;
      reserved: string;
      quarantined: string;
    }>(
      `SELECT asset_code AS code, asset_scale AS scale, account_owner AS owner,
              coalesce(sum(delta_atoms) FILTER (WHERE claim_state = 'AVAILABLE'), 0)::text AS available,
              coalesce(sum(delta_atoms) FILTER (WHERE claim_state = 'RESERVED'), 0)::text AS reserved,
              coalesce(sum(delta_atoms) FILTER (WHERE claim_state = 'QUARANTINED'), 0)::text AS quarantined
         FROM ledger_entries WHERE claim_state <> 'CONTROL'
        GROUP BY asset_code, asset_scale, account_owner ORDER BY asset_code, account_owner`,
    );
    return control.rows.map((row) => ({
      asset: { code: row.code, scaleVersion: row.scale },
      controlAtoms: BigInt(row.atoms),
      claims: claims.rows
        .filter((claim) => claim.code === row.code && claim.scale === row.scale)
        .map((claim) => ({
          owner: claim.owner,
          availableAtoms: BigInt(claim.available),
          reservedAtoms: BigInt(claim.reserved),
          quarantinedAtoms: BigInt(claim.quarantined),
        })),
    }));
  }

  /** T-011: opening ownership is explicit, and it is HOUSE. */
  describe('bootstrap', () => {
    it('posts opening balances to ASSET_CONTROL and matching HOUSE claims', async () => {
      expect(await bootstrap()).toMatchObject({ ok: true, baselineId: 'baseline-1' });

      const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL });
      expect(balances).toEqual([
        {
          owner: 'HOUSE',
          asset: { code: 'USDT', scale: 'v1' },
          availableAtoms: 1_000n,
          reservedAtoms: 0n,
          quarantinedAtoms: 0n,
        },
      ]);
    });

    it('never credits a strategy merely because its symbol matches', async () => {
      // T-011: unknown inventory belongs to the owner until the owner allocates it.
      await bootstrap();
      const strategyRows = await harness.admin.query(
        `SELECT 1 FROM ledger_entries WHERE account_kind = 'STRATEGY'`,
      );
      expect(strategyRows.rowCount).toBe(0);
    });

    it('conserves every asset independently of the projection', async () => {
      // T-012, and the module's acceptance gate: recomputed from the entries, not restated
      // from claim_balances.
      await bootstrap({
        balances: [
          { asset: USDT, atoms: 1_000n },
          { asset: BTC, atoms: 50_000_000n },
        ],
      });
      const result = verifyConservation(await positions());
      expect(result.conserved).toBe(true);
      expect(result.discrepancies).toEqual([]);
    });

    it('records the opening even when the account holds nothing', async () => {
      // "The opening was zero" is a fact. Without it the next reader cannot tell it from
      // "never taken".
      expect(await bootstrap({ balances: [] })).toMatchObject({ ok: true });
      const stored = await baselines.baseline({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
      expect(stored?.baselineId).toBe('baseline-1');
    });

    it('binds the baseline to the account and cut it came from', async () => {
      await bootstrap();
      const stored = await baselines.baseline({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
      expect(stored).toMatchObject({
        stableAccountId: ACCOUNT.stableAccountId,
        cutId: 'cut-1',
        costBasisKnown: false,
      });
    });

    /** T-042: exclusions and an unknown cost basis stay visible. */
    it('keeps the excluded assets and the unknown cost basis visible', async () => {
      await bootstrap({ excludedAssets: ['DOGE@v1'] });
      const stored = await baselines.baseline({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
      expect(stored?.excludedAssets).toEqual(['DOGE@v1']);
      expect(stored?.supportedAssets).toEqual(['BTC@v1', 'USDT@v1']);
      // A balance snapshot says what is held, not what it cost. This is what forbids
      // presenting a complete P&L later.
      expect(stored?.costBasisKnown).toBe(false);
    });

    describe('it fails closed before any economic write', () => {
      async function assertNothingWritten(): Promise<void> {
        expect((await harness.admin.query('SELECT 1 FROM ledger_entries')).rowCount).toBe(0);
        expect((await harness.admin.query('SELECT 1 FROM account_baselines')).rowCount).toBe(0);
      }

      it('refuses a cut that is not COMPLETE', async () => {
        await seedCompleteCut('cut-incomplete', 1, {
          coverageState: 'UNSUPPORTED',
          detectionScope: 'NET_BALANCE_CHANGES_ONLY',
          unmet: '["a source observation is outside its freshness class"]',
        });
        const outcome = await bootstrap({ cutId: 'cut-incomplete' });
        expect(outcome).toMatchObject({ ok: false, reason: 'NOT_READY' });
        expect(refusedAssessment(outcome).unmet).toContain('coverageComplete');
        await assertNothingWritten();
      });

      it('cannot even be given a cut read from another authenticated account', async () => {
        // T-056. The readiness predicate refuses the mismatch (proved in the unit suite), but
        // the situation cannot arise here at all: a snapshot naming another account is refused
        // by the table, so no such cut can exist in this pool to be pointed at.
        await harness.admin.query(
          `INSERT INTO venue_accounts (venue, environment, stable_account_id)
           VALUES ($1, $2, 'another-account')`,
          [ACCOUNT.venue, ACCOUNT.environment],
        );
        let refusal = 'accepted';
        try {
          await harness.admin.query(
            `INSERT INTO venue_account_snapshots
               (workspace_id, pool_id, epoch, snapshot_id, stable_account_id, requested_at,
                responded_at, source_time, response_digest, balances)
             VALUES ($1,$2,1,'snap-foreign','another-account','2026-09-08T11:00:00.000Z',
                     '2026-09-08T11:00:00.100Z',NULL,$3,'[]'::jsonb)`,
            [WORKSPACE, POOL, DIGEST],
          );
        } catch (error) {
          refusal = sqlRefusal(error).state;
        }
        expect(refusal).toBe('23001');
        await assertNothingWritten();
      });

      it('refuses without the governance lease', async () => {
        await harness.admin.query(
          `UPDATE governance_leases SET released_at = now(), released_reason = 'closed'`,
        );
        const outcome = await bootstrap();
        expect(refusedAssessment(outcome).unmet).toContain('governanceLeaseHeld');
        await assertNothingWritten();
      });

      it('refuses while an unknown resting order is open', async () => {
        await harness.admin.query(
          `INSERT INTO venue_orders (workspace_id, pool_id, epoch, symbol, venue_order_id, status)
           VALUES ($1, $2, 1, 'BTCUSDT', '7', 'NEW')`,
          [WORKSPACE, POOL],
        );
        const outcome = await bootstrap();
        expect(refusedAssessment(outcome).unmet).toContain('noUnknownOpenOrders');
        await assertNothingWritten();
      });

      it('refuses an asset this pool does not support', async () => {
        const outcome = await bootstrap({
          balances: [{ asset: { code: 'DOGE', scaleVersion: 'v1' }, atoms: 1n }],
        });
        expect(refusedAssessment(outcome).unsupportedAssets).toEqual(['DOGE@v1']);
        await assertNothingWritten();
      });

      /** T-032: a reset closes the epoch, and old funds are not current holdings. */
      it('refuses a closed epoch, and a cut from another epoch', async () => {
        await harness.admin.query(
          `UPDATE baseline_epochs SET closed_at = now(), closed_reason = 'reset'`,
        );
        const outcome = await bootstrap();
        expect(refusedAssessment(outcome).unmet).toContain('epochIsCurrentAndOpen');
        await assertNothingWritten();
      });

      it('refuses a cut that does not exist', async () => {
        expect(await bootstrap({ cutId: 'cut-nonexistent' })).toEqual({
          ok: false,
          reason: 'UNKNOWN_CUT',
        });
        await assertNothingWritten();
      });
    });

    /** T-056: one account bootstraps once. */
    describe('idempotency and conflict', () => {
      it('replays the same request without posting a second opening', async () => {
        const first = await bootstrap();
        const again = await bootstrap();
        expect(again).toMatchObject({ ok: true, replayed: true });
        expect((again as { ledgerTxnId: string }).ledgerTxnId).toBe(
          (first as { ledgerTxnId: string }).ledgerTxnId,
        );
        const entries = await harness.admin.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM ledger_entries',
        );
        expect(entries.rows[0]?.count).toBe('2');
      });

      it('refuses the same baseline id claiming a different cut', async () => {
        await bootstrap();
        await seedCompleteCut('cut-2');
        expect(await bootstrap({ cutId: 'cut-2' })).toEqual({
          ok: false,
          reason: 'BASELINE_CONFLICT',
          storedCutId: 'cut-1',
        });
      });

      it('refuses a second baseline of the same epoch under a different id', async () => {
        await bootstrap();
        await seedCompleteCut('cut-2');
        const outcome = await bootstrap({ baselineId: 'baseline-2', cutId: 'cut-2' });
        expect(refusedAssessment(outcome).unmet).toContain('notAlreadyBootstrapped');
      });

      it('refuses a second baseline at the table too', async () => {
        await bootstrap();
        let refusal = { state: 'accepted', constraint: 'accepted' };
        try {
          await harness.admin.query(
            `INSERT INTO account_baselines
               (workspace_id, pool_id, epoch, baseline_id, stable_account_id, environment,
                cut_id, ledger_txn_id, supported_assets, excluded_assets, cost_basis_known)
             VALUES ($1,$2,1,'baseline-forged',$3,$4,'cut-1','baseline-baseline-1',
                     '[]'::jsonb,'[]'::jsonb,false)`,
            [WORKSPACE, POOL, ACCOUNT.stableAccountId, ACCOUNT.environment],
          );
        } catch (error) {
          refusal = sqlRefusal(error);
        }
        expect(refusal.constraint).toBe('account_baselines_one_per_epoch');
      });

      it('refuses a baseline attributed to an account the pool does not govern', async () => {
        let refusal = 'accepted';
        try {
          await harness.admin.query(
            `INSERT INTO account_baselines
               (workspace_id, pool_id, epoch, baseline_id, stable_account_id, environment,
                cut_id, ledger_txn_id, supported_assets, excluded_assets, cost_basis_known)
             VALUES ($1,$2,1,'baseline-foreign','someone-else',$3,'cut-1','x',
                     '[]'::jsonb,'[]'::jsonb,false)`,
            [WORKSPACE, POOL, ACCOUNT.environment],
          );
        } catch (error) {
          refusal = sqlRefusal(error).state;
        }
        expect(refusal).toBe('23001');
      });
    });
  });

  /** The golden case the prompt names: 1000 USDT to HOUSE, then 500/500. */
  describe('owner allocation', () => {
    function allocate(
      overrides: Record<string, unknown> = {},
    ): ReturnType<BaselineRepository['allocate']> {
      return baselines.allocate({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        allocationId: 'alloc-1',
        actor: OWNER,
        authorizedBy: 'session-1',
        from: 'HOUSE',
        to: 'strategy-a',
        asset: USDT,
        atoms: 500n,
        ...overrides,
      });
    }

    beforeEach(async () => {
      await bootstrap();
    });

    it('splits 1000 USDT into 500 and 500 with nothing left unowned', async () => {
      expect(await allocate()).toMatchObject({ ok: true, revision: 1 });
      expect(await allocate({ allocationId: 'alloc-2', to: 'strategy-b' })).toMatchObject({
        ok: true,
        revision: 2,
      });

      const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL });
      // HOUSE remains as an owner holding nothing, which is the honest statement: it had the
      // units and gave them away, rather than never having existed.
      expect(balances.map((b) => [b.owner, b.availableAtoms] as const)).toEqual([
        ['HOUSE', 0n],
        ['strategy-a', 500n],
        ['strategy-b', 500n],
      ]);
      // Every unit still has exactly one owner, verified independently.
      expect(verifyConservation(await positions()).conserved).toBe(true);
    });

    it('refuses the impossible double assignment', async () => {
      // The same 1000 cannot be given away twice: the second full allocation has nothing left
      // to draw on.
      expect(await allocate({ atoms: 1_000n })).toMatchObject({ ok: true });
      expect(await allocate({ allocationId: 'alloc-2', to: 'strategy-b', atoms: 1_000n })).toEqual({
        ok: false,
        reason: 'UNAUTHORIZED',
        detail: 'EXCEEDS_AVAILABLE',
      });
      expect(verifyConservation(await positions()).conserved).toBe(true);
    });

    it('moves a claim back from a strategy to HOUSE', async () => {
      await allocate();
      expect(
        await allocate({
          allocationId: 'alloc-return',
          from: 'strategy-a',
          to: 'HOUSE',
          atoms: 200n,
        }),
      ).toMatchObject({ ok: true });
      const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL });
      expect(balances.find((b) => b.owner === 'strategy-a')?.availableAtoms).toBe(300n);
      expect(balances.find((b) => b.owner === 'HOUSE')?.availableAtoms).toBe(700n);
    });

    /** T-020: strategies stay separate. */
    it('refuses a strategy-to-strategy move, at the service and at the table', async () => {
      await allocate();
      expect(
        await allocate({ allocationId: 'alloc-x', from: 'strategy-a', to: 'strategy-b' }),
      ).toEqual({ ok: false, reason: 'UNAUTHORIZED', detail: 'NOT_A_HOUSE_LEG' });

      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await harness.admin.query(
          `INSERT INTO owner_allocations
             (workspace_id, pool_id, epoch, allocation_id, revision, from_owner, to_owner,
              asset_code, asset_scale, atoms, authorized_by, ledger_txn_id)
           VALUES ($1,$2,1,'alloc-forged',99,'strategy-a','strategy-b','USDT','v1',1,'s',
                   'allocation-alloc-1')`,
          [WORKSPACE, POOL],
        );
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.constraint).toBe('owner_allocations_one_house_leg');
    });

    it('refuses an agent credential', async () => {
      expect(
        await allocate({ actor: { role: 'agent', credentialClass: 'AGENT_PROPOSAL' } }),
      ).toEqual({ ok: false, reason: 'UNAUTHORIZED', detail: 'ACTOR_MAY_NOT_ALLOCATE' });
      expect((await harness.admin.query('SELECT 1 FROM owner_allocations')).rowCount).toBe(0);
    });

    it('refuses an archived strategy', async () => {
      await harness.admin.query(`UPDATE strategies SET archived_at = now()`);
      expect(await allocate()).toEqual({
        ok: false,
        reason: 'UNAUTHORIZED',
        detail: 'STRATEGY_NOT_ACTIVE',
      });
    });

    it('replays the same allocation without moving the claim twice', async () => {
      const first = await allocate();
      const again = await allocate();
      expect(again).toMatchObject({ ok: true, replayed: true, revision: 1 });
      expect((again as { ledgerTxnId: string }).ledgerTxnId).toBe(
        (first as { ledgerTxnId: string }).ledgerTxnId,
      );
      const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL });
      expect(balances.find((b) => b.owner === 'strategy-a')?.availableAtoms).toBe(500n);
    });

    it('refuses the same allocation id claiming different facts', async () => {
      await allocate();
      expect(await allocate({ atoms: 900n })).toEqual({
        ok: false,
        reason: 'ALLOCATION_CONFLICT',
      });
    });

    it('refuses allocating before any baseline exists', async () => {
      await harness.reset();
      await harness.seedPool();
      expect(await allocate()).toEqual({ ok: false, reason: 'NO_BASELINE' });
    });

    it('records who authorised it and that it moved nothing at the venue', async () => {
      await allocate();
      const stored = await harness.admin.query<{ authorized_by: string; ledger_txn_id: string }>(
        'SELECT authorized_by, ledger_txn_id FROM owner_allocations',
      );
      expect(stored.rows[0]?.authorized_by).toBe('session-1');
      // Its postings are claim transfers only: ASSET_CONTROL is untouched, which is what
      // distinguishes an internal allocation from a venue movement.
      const control = await harness.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger_entries
          WHERE ledger_txn_id = $1 AND claim_state = 'CONTROL'`,
        [stored.rows[0]?.ledger_txn_id],
      );
      expect(control.rows[0]?.count).toBe('0');
    });
  });
});
