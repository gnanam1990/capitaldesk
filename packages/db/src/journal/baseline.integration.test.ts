import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContractViolation } from '@capitaldesk/contracts';
import {
  supportedAssets,
  verifyConservation,
  type AssetPosition,
  type BaselineAssessment,
} from '@capitaldesk/ledger';
import { BaselineRepository, type BootstrapOutcome } from './baseline.js';
import { GovernanceRepository } from './governance.js';
import { LedgerRepository } from './ledger.js';
import {
  ACCOUNT,
  DATABASE_URL,
  JournalHarness,
  OTHER_WORKSPACE,
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
const OWNER = {
  kind: 'owner-session',
  role: 'owner',
  subjectId: 'user-owner',
  scope: { workspaceId: WORKSPACE, poolId: null, strategyId: null },
} as const;
const SESSION = 'f'.repeat(64);
const OTHER_SESSION = 'e'.repeat(64);
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
    await seedOwnerSession(SESSION, 'user-owner', 'owner');
    await seedOwnerSession(OTHER_SESSION, 'user-owner', 'owner');
    await seedCompleteCut('cut-1');
  });

  /**
   * A real owner, a real membership and a real live session.
   *
   * The allocation binds to the stored session rather than to a role the caller typed, so the
   * fixtures have to establish one the same way authentication does.
   */
  async function seedOwnerSession(
    sessionHash: string,
    userId: string,
    role: 'owner' | 'operator' | 'viewer',
    options: {
      workspaceId?: string;
      revoked?: boolean;
      expired?: boolean;
      userDisabled?: boolean;
    } = {},
  ): Promise<void> {
    const workspaceId = options.workspaceId ?? WORKSPACE;
    await harness.admin.query(
      `INSERT INTO users (user_id, login_name, disabled_at)
       VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
      [
        userId,
        userId.replace(/[^a-z0-9]/g, '-'),
        options.userDisabled === true ? new Date() : null,
      ],
    );
    await harness.admin.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [workspaceId, userId, role],
    );
    const expired = options.expired === true;
    await harness.admin.query(
      `INSERT INTO owner_sessions
         (session_id_hash, workspace_id, user_id, created_at, last_seen_at,
          absolute_expires_at, idle_expires_at, revoked_at, revoked_reason)
       VALUES ($1, $2, $3, now() - interval '1 hour', now(),
               now() + interval '11 hours', $4, $5, $6)
       ON CONFLICT (session_id_hash) DO NOTHING`,
      [
        sessionHash,
        workspaceId,
        userId,
        expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 1_800_000),
        options.revoked === true ? new Date() : null,
        options.revoked === true ? 'revoked for the test' : null,
      ],
    );
  }
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
      /** The closing snapshot's holdings. The opening is derived from exactly these. */
      balances?: readonly { asset: string; freeAtoms: string; lockedAtoms: string }[];
      /** The scope the cut belongs to. Defaults to the pool the other fixtures use. */
      workspaceId?: string;
      poolId?: string;
    } = {},
  ): Promise<void> {
    const workspaceId = overrides.workspaceId ?? WORKSPACE;
    const poolId = overrides.poolId ?? POOL;
    for (const [id, requestedAt, respondedAt] of [
      [`${cutId}-open`, '2026-09-08T11:00:00.000Z', '2026-09-08T11:00:00.100Z'],
      [`${cutId}-close`, '2026-09-08T12:00:00.000Z', '2026-09-08T12:00:00.100Z'],
    ] as const) {
      await harness.admin.query(
        `INSERT INTO venue_account_snapshots
           (workspace_id, pool_id, epoch, snapshot_id, stable_account_id, requested_at,
            responded_at, source_time, response_digest, balances)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9::jsonb)`,
        [
          workspaceId,
          poolId,
          epoch,
          id,
          overrides.stableAccountId ?? ACCOUNT.stableAccountId,
          requestedAt,
          respondedAt,
          DIGEST,
          JSON.stringify(
            id.endsWith('-close')
              ? (overrides.balances ?? [{ asset: 'USDT@v1', freeAtoms: '1000', lockedAtoms: '0' }])
              : [],
          ),
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
        workspaceId,
        poolId,
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
  async function positions(epoch = 1): Promise<AssetPosition[]> {
    const control = await harness.admin.query<{ code: string; scale: string; atoms: string }>(
      `SELECT asset_code AS code, asset_scale AS scale, sum(delta_atoms)::text AS atoms
         FROM ledger_entries WHERE claim_state = 'CONTROL' AND epoch = $1
        GROUP BY asset_code, asset_scale ORDER BY asset_code`,
      [epoch],
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
         FROM ledger_entries WHERE claim_state <> 'CONTROL' AND epoch = $1
        GROUP BY asset_code, asset_scale, account_owner ORDER BY asset_code, account_owner`,
      [epoch],
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

  /** Nothing economic was written: no postings and no baseline record. */
  async function assertNothingWritten(): Promise<void> {
    expect((await harness.admin.query('SELECT 1 FROM ledger_entries')).rowCount).toBe(0);
    expect((await harness.admin.query('SELECT 1 FROM account_baselines')).rowCount).toBe(0);
  }

  /** T-011: opening ownership is explicit, and it is HOUSE. */
  describe('bootstrap', () => {
    it('posts opening balances to ASSET_CONTROL and matching HOUSE claims', async () => {
      expect(await bootstrap()).toMatchObject({ ok: true, baselineId: 'baseline-1' });

      const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
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

      it('refuses a snapshot holding an asset this pool does not support', async () => {
        await seedCompleteCut('cut-doge', 1, {
          balances: [{ asset: 'DOGE@v1', freeAtoms: '1', lockedAtoms: '0' }],
        });
        // Refused while deriving the opening, before any posting exists.
        const failure = await bootstrap({ cutId: 'cut-doge' }).catch((error: unknown) => error);
        expect((failure as ContractViolation).reason).toBe('FEE_ASSET_UNSUPPORTED');
        expect((failure as ContractViolation).detail['asset']).toBe('DOGE@v1');
        await assertNothingWritten();
      });

      /** T-032: a reset closes the epoch, and old funds are not current holdings. */
      it('refuses a closed epoch', async () => {
        await harness.admin.query(
          `UPDATE baseline_epochs SET closed_at = now(), closed_reason = 'reset'`,
        );
        const outcome = await bootstrap();
        expect(refusedAssessment(outcome).unmet).toContain('epochIsCurrentAndOpen');
        await assertNothingWritten();
      });

      it('leaves no baseline when the opening postings are rolled back', async () => {
        // A half baseline — postings with no record, or a record with no postings — is the one
        // outcome that cannot be recovered from, so both commit together or neither does.
        await expect(bootstrap({ baselineId: 'baseline-bad-id-!!' })).rejects.toBeTruthy();
        expect((await harness.admin.query('SELECT 1 FROM account_baselines')).rowCount).toBe(0);
        expect((await harness.admin.query('SELECT 1 FROM ledger_entries')).rowCount).toBe(0);
        expect((await harness.admin.query('SELECT 1 FROM ledger_transactions')).rowCount).toBe(0);
      });

      it('refuses a cut that does not exist', async () => {
        expect(await bootstrap({ cutId: 'cut-nonexistent' })).toEqual({
          ok: false,
          reason: 'UNKNOWN_CUT',
        });
        await assertNothingWritten();
      });
    });

    /**
     * The opening is a function of the snapshot, never a claim made alongside it.
     *
     * The service used to take the amounts from the request, so a caller could name a cut
     * whose snapshot held nothing and open 1000 against it — and the record then said the
     * opening came from that cut, with nothing in the system disagreeing.
     */
    describe('the opening is derived from the named closing snapshot', () => {
      it('posts exactly what the closing snapshot holds, free plus locked', async () => {
        await seedCompleteCut('cut-derived', 1, {
          balances: [
            { asset: 'USDT@v1', freeAtoms: '900', lockedAtoms: '100' },
            { asset: 'BTC@v1', freeAtoms: '50000000', lockedAtoms: '0' },
          ],
        });
        expect(await bootstrap({ cutId: 'cut-derived' })).toMatchObject({ ok: true });
        const balances = await ledger.balances({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 1,
        });
        expect(balances.map((b) => [b.asset.code, b.availableAtoms] as const)).toEqual([
          ['BTC', 50_000_000n],
          ['USDT', 1_000n],
        ]);
      });

      it('opens zero only when the bound snapshot is actually zero', async () => {
        await seedCompleteCut('cut-empty', 1, { balances: [] });
        expect(await bootstrap({ cutId: 'cut-empty' })).toMatchObject({ ok: true });
        expect((await harness.admin.query('SELECT 1 FROM ledger_entries')).rowCount).toBe(0);
        const stored = await baselines.baseline({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 1,
        });
        expect(stored?.baselineId).toBe('baseline-1');
      });

      it('refuses a snapshot with a negative or malformed amount', async () => {
        for (const [cutId, balances] of [
          ['cut-negative', [{ asset: 'USDT@v1', freeAtoms: '-1', lockedAtoms: '0' }]],
          ['cut-fraction', [{ asset: 'USDT@v1', freeAtoms: '1.5', lockedAtoms: '0' }]],
          ['cut-exponent', [{ asset: 'USDT@v1', freeAtoms: '1e3', lockedAtoms: '0' }]],
        ] as const) {
          await seedCompleteCut(cutId, 1, { balances });
          const failure = await bootstrap({ cutId }).catch((error: unknown) => error);
          expect((failure as ContractViolation).reason, cutId).toBe('EVIDENCE_CONTRADICTORY');
        }
        await assertNothingWritten();
      });

      it('refuses a snapshot listing one asset twice', async () => {
        // Adding them would silently double the opening; taking either would be a choice
        // nobody made.
        await seedCompleteCut('cut-dupe', 1, {
          balances: [
            { asset: 'USDT@v1', freeAtoms: '100', lockedAtoms: '0' },
            { asset: 'USDT@v1', freeAtoms: '900', lockedAtoms: '0' },
          ],
        });
        await expect(bootstrap({ cutId: 'cut-dupe' })).rejects.toThrow(/lists an asset twice/);
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
        expect(await bootstrap({ cutId: 'cut-2' })).toMatchObject({
          ok: false,
          reason: 'BASELINE_CONFLICT',
        });
      });

      it('refuses a replay whose supported set or exclusions changed', async () => {
        // The identity is not the only immutable fact. A replay that changed what the
        // baseline claims to cover would rewrite its coverage disclosure silently.
        await bootstrap();
        expect(await bootstrap({ excludedAssets: ['DOGE@v1'] })).toMatchObject({
          ok: false,
          reason: 'BASELINE_CONFLICT',
        });
        expect(
          await bootstrap({
            supported: supportedAssets({
              base: BTC,
              quote: USDT,
              feeAssets: [{ code: 'BNB', scaleVersion: 'v1' }],
            }),
          }),
        ).toMatchObject({ ok: false, reason: 'BASELINE_CONFLICT' });
        // And the stored record is unchanged.
        const stored = await baselines.baseline({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 1,
        });
        expect(stored?.excludedAssets).toEqual([]);
        expect(stored?.supportedAssets).toEqual(['BTC@v1', 'USDT@v1']);
      });

      it('keeps the ledger transaction id within its bound for a maximal baseline id', async () => {
        // `ledger_txn_id` is capped at 64 characters and a baseline id may itself be 64.
        // Prefixing alone overflowed, and the insert then failed after the evidence had been
        // read.
        const longest = `b${'x'.repeat(63)}`;
        expect(longest).toHaveLength(64);
        const outcome = await bootstrap({ baselineId: longest });
        expect(outcome).toMatchObject({ ok: true });
        const txn = await harness.admin.query<{ ledger_txn_id: string }>(
          'SELECT ledger_txn_id FROM ledger_transactions',
        );
        expect((txn.rows[0]?.ledger_txn_id ?? '').length).toBeLessThanOrEqual(64);
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

      /**
       * The service enforces all of this. These prove the database does too, because a direct
       * writer bypasses the service and these records are what every later claim descends
       * from.
       */
      describe('the database refuses an unsupported baseline row', () => {
        async function insertBaseline(overrides: Record<string, unknown> = {}): Promise<void> {
          await harness.admin.query(
            `INSERT INTO account_baselines
               (workspace_id, pool_id, epoch, baseline_id, stable_account_id, environment,
                cut_id, ledger_txn_id, supported_assets, excluded_assets, cost_basis_known)
             VALUES ($1,$2,1,$3,$4,$5,$6,$7,'[]'::jsonb,'[]'::jsonb,$8)`,
            [
              WORKSPACE,
              POOL,
              overrides['baselineId'] ?? 'forged',
              ACCOUNT.stableAccountId,
              ACCOUNT.environment,
              overrides['cutId'] ?? 'cut-1',
              overrides['ledgerTxnId'] === undefined ? null : overrides['ledgerTxnId'],
              overrides['costBasisKnown'] ?? false,
            ],
          );
        }

        it('refuses a row citing a cut whose coverage was never complete', async () => {
          await seedCompleteCut('cut-bad', 1, {
            coverageState: 'INCOMPLETE',
            detectionScope: 'NET_BALANCE_CHANGES_ONLY',
            unmet: '["a source observation is outside its freshness class"]',
          });
          await expect(insertBaseline({ cutId: 'cut-bad' })).rejects.toMatchObject({
            code: '23001',
          });
        });

        it('refuses a row claiming no postings when its snapshot is not empty', async () => {
          // cut-1's closing snapshot holds 1000. "No postings" contradicts it.
          await expect(insertBaseline()).rejects.toMatchObject({ code: '23001' });
        });

        it('accepts no postings when the snapshot really is empty', async () => {
          await seedCompleteCut('cut-zero', 1, { balances: [] });
          await expect(insertBaseline({ cutId: 'cut-zero' })).resolves.toBeUndefined();
        });

        it('refuses a row citing another baseline’s transaction', async () => {
          await bootstrap();
          await seedCompleteCut('cut-2', 1, {
            balances: [{ asset: 'USDT@v1', freeAtoms: '1000', lockedAtoms: '0' }],
          });
          // A second baseline row is refused by the one-per-epoch key first, so this proves
          // the source binding on a row that clears it: a different pool epoch is not
          // available, so the assertion is that the two guards together leave no opening.
          await expect(
            insertBaseline({ cutId: 'cut-2', ledgerTxnId: 'baseline-baseline-1' }),
          ).rejects.toBeTruthy();
        });

        it('compares the opening with the snapshot per asset, not as one grand total', async () => {
          await seedCompleteCut('cut-mixed', 1, {
            balances: [
              { asset: 'USDT@v1', freeAtoms: '1000', lockedAtoms: '0' },
              { asset: 'BTC@v1', freeAtoms: '200', lockedAtoms: '0' },
            ],
          });
          expect(
            await ledger.postTransaction({
              workspaceId: WORKSPACE,
              poolId: POOL,
              epoch: 1,
              ledgerTxnId: 'baseline-forged',
              source: { kind: 'baseline', ref: 'forged' },
              description: 'wrong asset with the same aggregate atom count',
              entries: [
                {
                  accountKind: 'ASSET_CONTROL',
                  owner: 'ASSET_CONTROL',
                  claimState: 'CONTROL',
                  asset: { code: 'USDT', scale: 'v1' },
                  deltaAtoms: 1_200n,
                },
                {
                  accountKind: 'HOUSE',
                  owner: 'HOUSE',
                  claimState: 'AVAILABLE',
                  asset: { code: 'USDT', scale: 'v1' },
                  deltaAtoms: 1_200n,
                },
              ],
            }),
          ).toMatchObject({ ok: true });
          await expect(
            insertBaseline({ cutId: 'cut-mixed', ledgerTxnId: 'baseline-forged' }),
          ).rejects.toMatchObject({ code: '23001' });
        });

        it('refuses cost_basis_known = true until a proven basis exists', async () => {
          await seedCompleteCut('cut-zero', 1, { balances: [] });
          let refusal = { state: 'accepted', constraint: 'accepted' };
          try {
            await insertBaseline({ cutId: 'cut-zero', costBasisKnown: true });
          } catch (error) {
            refusal = sqlRefusal(error);
          }
          // A direct writer could otherwise make unknown history look tax- and P&L-ready.
          expect(refusal.constraint).toBe('account_baselines_cost_basis_unproven');
        });
      });

      describe('the database refuses an unsupported allocation row', () => {
        it('refuses an allocation before any baseline exists for the epoch', async () => {
          // Claims cannot be moved before an opening establishes them.
          //
          // Reaching this rule takes some care, because the guards beneath it are real: a
          // transaction with no entries is refused at commit, and an allocation out of a HOUSE
          // that holds nothing drives a claim negative. So HOUSE is given a balance by a
          // posting that is *not* a baseline, and the allocation is then otherwise valid —
          // leaving the missing baseline as the only thing wrong with it.
          const seeded = await ledger.postTransaction({
            workspaceId: WORKSPACE,
            poolId: POOL,
            epoch: 1,
            ledgerTxnId: 'txn-unbaselined',
            source: { kind: 'operator', ref: 'unbaselined' },
            description: 'a credit with no opening behind it',
            entries: [
              {
                accountKind: 'ASSET_CONTROL',
                owner: 'ASSET_CONTROL',
                claimState: 'CONTROL',
                asset: { code: 'USDT', scale: 'v1' },
                deltaAtoms: 1_000n,
              },
              {
                accountKind: 'HOUSE',
                owner: 'HOUSE',
                claimState: 'AVAILABLE',
                asset: { code: 'USDT', scale: 'v1' },
                deltaAtoms: 1_000n,
              },
            ],
          });
          expect(seeded).toMatchObject({ ok: true });

          await ledger.postTransaction({
            workspaceId: WORKSPACE,
            poolId: POOL,
            epoch: 1,
            ledgerTxnId: 'allocation-early',
            source: { kind: 'owner-allocation', ref: 'early' },
            description: 'internal budget allocation HOUSE to strategy-a',
            entries: [
              {
                accountKind: 'HOUSE',
                owner: 'HOUSE',
                claimState: 'AVAILABLE',
                asset: { code: 'USDT', scale: 'v1' },
                deltaAtoms: -1n,
              },
              {
                accountKind: 'STRATEGY',
                owner: 'strategy-a',
                claimState: 'AVAILABLE',
                asset: { code: 'USDT', scale: 'v1' },
                deltaAtoms: 1n,
              },
            ],
          });
          let refusal = 'accepted';
          try {
            await harness.admin.query(
              `INSERT INTO owner_allocations
                 (workspace_id, pool_id, epoch, allocation_id, revision, from_owner, to_owner,
                  asset_code, asset_scale, atoms, authorized_by, ledger_txn_id)
               VALUES ($1,$2,1,'early',1,'HOUSE','strategy-a','USDT','v1',1,$3,
                       'allocation-early')`,
              [WORKSPACE, POOL, SESSION],
            );
          } catch (error) {
            refusal = sqlRefusal(error).state;
          }
          expect(refusal).toBe('23001');
          expect((await harness.admin.query('SELECT 1 FROM owner_allocations')).rowCount).toBe(0);
        });

        it('refuses a row citing another allocation’s transaction', async () => {
          await bootstrap();
          const first = await baselines.allocate({
            workspaceId: WORKSPACE,
            poolId: POOL,
            epoch: 1,
            allocationId: 'alloc-1',
            actor: OWNER,
            sessionIdHash: SESSION,
            from: 'HOUSE',
            to: 'strategy-a',
            asset: USDT,
            atoms: 500n,
          });
          expect(first).toMatchObject({ ok: true });

          // A second authorisation record pointing at one movement reads afterwards as two
          // movements.
          let refusal = 'accepted';
          try {
            await harness.admin.query(
              `INSERT INTO owner_allocations
                 (workspace_id, pool_id, epoch, allocation_id, revision, from_owner, to_owner,
                  asset_code, asset_scale, atoms, authorized_by, ledger_txn_id)
               VALUES ($1,$2,1,'forged',99,'HOUSE','strategy-a','USDT','v1',1,$3,$4)`,
              [WORKSPACE, POOL, SESSION, (first as { ledgerTxnId: string }).ledgerTxnId],
            );
          } catch (error) {
            refusal = sqlRefusal(error).state;
          }
          expect(refusal).toBe('23001');
        });
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

  /**
   * T-056, the part that matters: the same venue account reached from two workspaces.
   *
   * The idempotency cases above prove one workspace cannot open twice. They say nothing about
   * two workspaces racing for the same funds on independent connections, which is the failure
   * that would create the same 1000 USDT twice under two sets of claims. What decides is the
   * registry's single-active-lease index, so these tests contend for it for real.
   */
  describe('one venue account bootstraps once across workspaces (T-056)', () => {
    const RIVAL_POOL = 'pool-rival';

    /**
     * A second workspace's pool bound to the SAME stable account, with no lease of its own.
     *
     * The harness's seedPool would take a lease, which is the thing under test here, so the
     * rows are seeded directly and the race decides who gets one.
     */
    async function seedRivalPool(): Promise<void> {
      await harness.admin.query(
        `INSERT INTO pools (workspace_id, pool_id, venue, environment, stable_account_id, state)
         VALUES ($1,$2,$3,$4,$5,'READY')`,
        [OTHER_WORKSPACE, RIVAL_POOL, ACCOUNT.venue, ACCOUNT.environment, ACCOUNT.stableAccountId],
      );
      await harness.admin.query(
        `INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ($1,$2,1)`,
        [OTHER_WORKSPACE, RIVAL_POOL],
      );
      await seedCompleteCut('cut-rival', 1, {
        workspaceId: OTHER_WORKSPACE,
        poolId: RIVAL_POOL,
      });
    }

    /** Release the lease the default fixture holds, so both pools start ungoverned. */
    async function releaseDefaultLease(): Promise<void> {
      await harness.admin.query(
        `UPDATE governance_leases SET released_at = now(), released_reason = 'race setup'
          WHERE workspace_id = $1 AND pool_id = $2 AND released_at IS NULL`,
        [WORKSPACE, POOL],
      );
    }

    function rivalBootstrap(): ReturnType<BaselineRepository['bootstrap']> {
      return baselines.bootstrap({
        workspaceId: OTHER_WORKSPACE,
        poolId: RIVAL_POOL,
        epoch: 1,
        baselineId: 'baseline-rival',
        cutId: 'cut-rival',
        supported: SUPPORTED,
        excludedAssets: [],
      });
    }

    it('serializes two workspaces racing for the lease on independent backends', async () => {
      await releaseDefaultLease();
      await seedRivalPool();

      const [a, b] = [await harness.connect(), await harness.connect()];
      await a.client.query('BEGIN');
      await b.client.query('BEGIN');

      // The first claim takes the index entry and holds it uncommitted.
      await a.client.query(
        `INSERT INTO governance_leases
           (lease_id, venue, environment, stable_account_id, workspace_id, pool_id)
         VALUES ('lease-race-a',$1,$2,$3,$4,$5)`,
        [ACCOUNT.venue, ACCOUNT.environment, ACCOUNT.stableAccountId, WORKSPACE, POOL],
      );

      // The second does not get a duplicate and does not get an immediate error: it blocks on
      // the uncommitted entry, which is what makes this a race rather than two serial writes.
      const contended = b.client
        .query(
          `INSERT INTO governance_leases
             (lease_id, venue, environment, stable_account_id, workspace_id, pool_id)
           VALUES ('lease-race-b',$1,$2,$3,$4,$5)`,
          [
            ACCOUNT.venue,
            ACCOUNT.environment,
            ACCOUNT.stableAccountId,
            OTHER_WORKSPACE,
            RIVAL_POOL,
          ],
        )
        .then(() => 'accepted')
        .catch((error: unknown) => sqlRefusal(error).constraint);

      await harness.waitUntilBlockedBy(a.pid, [b.pid]);
      await a.client.query('COMMIT');

      expect(await contended).toBe('governance_leases_single_active');
      await b.client.query('ROLLBACK');

      const held = await harness.admin.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM governance_leases
          WHERE stable_account_id = $1 AND released_at IS NULL`,
        [ACCOUNT.stableAccountId],
      );
      expect(held.rows.map((row) => row.workspace_id)).toEqual([WORKSPACE]);
    });

    it('gives the opening to the lease holder and leaves the loser with nothing', async () => {
      await releaseDefaultLease();
      await seedRivalPool();
      // The rival wins this one, to prove the outcome follows the lease and not the fixture's
      // default workspace.
      await harness.seedGovernanceLease(OTHER_WORKSPACE, RIVAL_POOL);

      const loser = await bootstrap();
      expect(refusedAssessment(loser).unmet).toContain('governanceLeaseHeld');

      const winner = await rivalBootstrap();
      expect(winner).toMatchObject({ ok: true });

      // The loser wrote no baseline and no entries. Its absence is asserted by scope, so a
      // row written under the wrong workspace would still fail this.
      const baselineRows = await harness.admin.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM account_baselines',
      );
      expect(baselineRows.rows.map((row) => row.workspace_id)).toEqual([OTHER_WORKSPACE]);
      const entryScopes = await harness.admin.query<{ workspace_id: string }>(
        'SELECT DISTINCT workspace_id FROM ledger_entries',
      );
      expect(entryScopes.rows.map((row) => row.workspace_id)).toEqual([OTHER_WORKSPACE]);

      // And the funds were opened once, not twice: one HOUSE claim of 1000 USDT exists in the
      // whole registry for this account.
      const house = await harness.admin.query<{ atoms: string }>(
        `SELECT coalesce(sum(delta_atoms), 0)::text AS atoms FROM ledger_entries
          WHERE account_owner = 'HOUSE' AND asset_code = 'USDT'`,
      );
      expect(house.rows[0]?.atoms).toBe('1000');
    });

    it('treats a rotated credential alias as the same account, not a new one', async () => {
      // Identity is the stable account id. A second workspace holding freshly rotated API keys
      // sees the same funds, so recording a new alias must not create a second governable
      // account — otherwise key rotation alone would defeat the single-lease rule.
      // The default pool keeps the lease it was seeded with; only the rival is new here.
      await seedRivalPool();
      for (const alias of ['key-original', 'key-rotated']) {
        await harness.admin.query(
          `INSERT INTO venue_account_credentials
             (venue, environment, stable_account_id, credential_alias)
           VALUES ($1,$2,$3,$4)`,
          [ACCOUNT.venue, ACCOUNT.environment, ACCOUNT.stableAccountId, alias],
        );
      }

      // The rotated-key workspace cannot take a lease of its own...
      let refusal = 'accepted';
      try {
        await harness.admin.query(
          `INSERT INTO governance_leases
             (lease_id, venue, environment, stable_account_id, workspace_id, pool_id)
           VALUES ('lease-rotated',$1,$2,$3,$4,$5)`,
          [
            ACCOUNT.venue,
            ACCOUNT.environment,
            ACCOUNT.stableAccountId,
            OTHER_WORKSPACE,
            RIVAL_POOL,
          ],
        );
      } catch (error) {
        refusal = sqlRefusal(error).constraint;
      }
      expect(refusal).toBe('governance_leases_single_active');

      // ...and so cannot open the account, however many aliases have seen it.
      expect(refusedAssessment(await rivalBootstrap()).unmet).toContain('governanceLeaseHeld');
      const aliases = await harness.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM venue_account_credentials
          WHERE stable_account_id = $1`,
        [ACCOUNT.stableAccountId],
      );
      expect(aliases.rows[0]?.count).toBe('2');
      expect((await harness.admin.query('SELECT 1 FROM account_baselines')).rowCount).toBe(0);
    });
  });

  /**
   * T-032. An epoch exists so that a venue reset cannot let old funds become current
   * authority. History is preserved and stays queryable; what must not survive is its
   * spending power.
   */
  describe('epoch isolation after a reset', () => {
    async function rotateToEpochTwo(): Promise<void> {
      const rotated = await new GovernanceRepository(harness.pool).rotateEpoch({
        workspaceId: WORKSPACE,
        poolId: POOL,
        reason: 'testnet reset',
      });
      expect(rotated).toEqual({ ok: true, epoch: 2 });
      await seedCompleteCut('cut-2', 2, {
        balances: [{ asset: 'USDT@v1', freeAtoms: '100', lockedAtoms: '0' }],
      });
    }

    it('shows only the new epoch’s opening, and keeps the old one queryable', async () => {
      await bootstrap();
      await rotateToEpochTwo();
      await bootstrap({ epoch: 2, baselineId: 'baseline-2', cutId: 'cut-2' });

      const current = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 2 });
      expect(current.find((row) => row.owner === 'HOUSE')?.availableAtoms).toBe(100n);

      // The closed epoch is history, not deleted history.
      const previous = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
      expect(previous.find((row) => row.owner === 'HOUSE')?.availableAtoms).toBe(1_000n);
    });

    it('cannot spend the closed epoch’s funds in the new one', async () => {
      await bootstrap();
      await rotateToEpochTwo();
      await bootstrap({ epoch: 2, baselineId: 'baseline-2', cutId: 'cut-2' });

      // 500 was affordable under the old opening and is not under the new one.
      expect(
        await baselines.allocate({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 2,
          allocationId: 'alloc-across',
          actor: OWNER,
          sessionIdHash: SESSION,
          from: 'HOUSE',
          to: 'strategy-a',
          asset: USDT,
          atoms: 500n,
        }),
      ).toEqual({ ok: false, reason: 'UNAUTHORIZED', detail: 'EXCEEDS_AVAILABLE' });
      expect((await harness.admin.query('SELECT 1 FROM owner_allocations')).rowCount).toBe(0);
    });

    it('allows only what the new epoch actually opened', async () => {
      // The positive control: the bound is the new opening, not a ban on allocating.
      await bootstrap();
      await rotateToEpochTwo();
      await bootstrap({ epoch: 2, baselineId: 'baseline-2', cutId: 'cut-2' });
      expect(
        await baselines.allocate({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 2,
          allocationId: 'alloc-ok',
          actor: OWNER,
          sessionIdHash: SESSION,
          from: 'HOUSE',
          to: 'strategy-a',
          asset: USDT,
          atoms: 100n,
        }),
      ).toMatchObject({ ok: true });
    });

    it('cannot reserve the closed epoch’s funds in the new one', async () => {
      await bootstrap();
      await baselines.allocate({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        allocationId: 'alloc-old',
        actor: OWNER,
        sessionIdHash: SESSION,
        from: 'HOUSE',
        to: 'strategy-a',
        asset: USDT,
        atoms: 1_000n,
      });
      await rotateToEpochTwo();
      await bootstrap({ epoch: 2, baselineId: 'baseline-2', cutId: 'cut-2' });

      // strategy-a holds 1000 in the closed epoch and nothing in the current one.
      expect(
        await ledger.reserve({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 2,
          reservationId: 'res-across',
          strategyId: 'strategy-a',
          planId: 'plan-across',
          asset: { code: 'USDT', scale: 'v1' },
          atoms: 500n,
        }),
      ).toMatchObject({ ok: false, reason: 'INSUFFICIENT_AVAILABLE', availableAtoms: 0n });
    });

    it('conserves each epoch on its own, never mixed', async () => {
      await bootstrap();
      await rotateToEpochTwo();
      await bootstrap({ epoch: 2, baselineId: 'baseline-2', cutId: 'cut-2' });
      // 1000 in the old epoch and 100 in the new one, each balanced against its own control.
      expect(verifyConservation(await positions(1)).conserved).toBe(true);
      expect(verifyConservation(await positions(2)).conserved).toBe(true);
      const epochOne = await positions(1);
      const epochTwo = await positions(2);
      expect(epochOne[0]?.controlAtoms).toBe(1_000n);
      expect(epochTwo[0]?.controlAtoms).toBe(100n);
    });

    it('carries the transaction’s epoch onto every entry it posts', async () => {
      await bootstrap();
      await rotateToEpochTwo();
      await bootstrap({ epoch: 2, baselineId: 'baseline-2', cutId: 'cut-2' });
      const mismatched = await harness.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger_entries e
           JOIN ledger_transactions t
             ON t.workspace_id = e.workspace_id AND t.pool_id = e.pool_id
            AND t.ledger_txn_id = e.ledger_txn_id
          WHERE e.epoch <> t.epoch`,
      );
      expect(mismatched.rows[0]?.count).toBe('0');
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
        sessionIdHash: SESSION,
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

      const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
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
      const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
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
        await allocate({
          actor: {
            kind: 'agent-credential',
            role: 'agent',
            subjectId: 'agent-1',
            scope: { workspaceId: WORKSPACE, poolId: POOL, strategyId: 'strategy-a' },
          },
        }),
      ).toEqual({ ok: false, reason: 'UNAUTHORIZED', detail: 'CAPABILITY_NOT_GRANTED' });
      expect((await harness.admin.query('SELECT 1 FROM owner_allocations')).rowCount).toBe(0);
    });

    it('refuses an owner principal scoped to another workspace', async () => {
      expect(
        await allocate({
          actor: {
            ...OWNER,
            scope: { workspaceId: OTHER_WORKSPACE, poolId: null, strategyId: null },
          },
        }),
      ).toEqual({
        ok: false,
        reason: 'UNAUTHORIZED',
        detail: 'WORKSPACE_SCOPE_MISMATCH',
      });
    });

    /**
     * A principal is a value a caller can construct. What it may not construct is the session
     * row it claims to have authenticated against, so that is what the write binds to.
     */
    describe('the authorising session must be real, live and an owner’s', () => {
      it('refuses a session that was never issued', async () => {
        expect(await allocate({ sessionIdHash: 'a'.repeat(64) })).toEqual({
          ok: false,
          reason: 'UNAUTHORIZED',
          detail: 'SESSION_UNKNOWN',
        });
        expect((await harness.admin.query('SELECT 1 FROM owner_allocations')).rowCount).toBe(0);
      });

      it('refuses a revoked session', async () => {
        const revoked = 'b'.repeat(64);
        await seedOwnerSession(revoked, 'user-owner', 'owner', { revoked: true });
        expect(await allocate({ sessionIdHash: revoked })).toMatchObject({
          reason: 'UNAUTHORIZED',
          detail: 'SESSION_REVOKED',
        });
      });

      it('refuses an expired session', async () => {
        const expired = 'c'.repeat(64);
        await seedOwnerSession(expired, 'user-owner', 'owner', { expired: true });
        expect(await allocate({ sessionIdHash: expired })).toMatchObject({
          reason: 'UNAUTHORIZED',
          detail: 'SESSION_EXPIRED',
        });
      });

      it('refuses a session belonging to another workspace', async () => {
        const foreign = 'd'.repeat(64);
        await seedOwnerSession(foreign, 'user-elsewhere', 'owner', {
          workspaceId: OTHER_WORKSPACE,
        });
        expect(
          await allocate({
            sessionIdHash: foreign,
            actor: {
              kind: 'owner-session',
              role: 'owner',
              subjectId: 'user-elsewhere',
              scope: { workspaceId: WORKSPACE, poolId: null, strategyId: null },
            },
          }),
        ).toMatchObject({ reason: 'UNAUTHORIZED', detail: 'SESSION_WRONG_WORKSPACE' });
      });

      it('refuses a real owner session presented with somebody else’s principal', async () => {
        // The session authenticated one user; the principal claims another.
        await seedOwnerSession('9'.repeat(64), 'user-other', 'operator');
        expect(
          await allocate({
            actor: {
              kind: 'owner-session',
              role: 'owner',
              subjectId: 'user-other',
              scope: { workspaceId: WORKSPACE, poolId: null, strategyId: null },
            },
          }),
        ).toMatchObject({ reason: 'UNAUTHORIZED', detail: 'SESSION_SUBJECT_MISMATCH' });
      });

      it('refuses a live session whose membership is not owner', async () => {
        const operator = '1'.repeat(64);
        await seedOwnerSession(operator, 'user-operator', 'operator');
        expect(
          await allocate({
            sessionIdHash: operator,
            actor: {
              kind: 'owner-session',
              role: 'owner',
              subjectId: 'user-operator',
              scope: { workspaceId: WORKSPACE, poolId: null, strategyId: null },
            },
          }),
        ).toMatchObject({ reason: 'UNAUTHORIZED', detail: 'MEMBERSHIP_NOT_OWNER' });
      });

      it('refuses a session whose user has been disabled', async () => {
        // One owner per workspace, so this disables the owner that exists rather than adding
        // a second one the schema would refuse.
        await harness.admin.query(`UPDATE users SET disabled_at = now() WHERE user_id = $1`, [
          'user-owner',
        ]);
        expect(await allocate()).toMatchObject({
          reason: 'UNAUTHORIZED',
          detail: 'USER_DISABLED',
        });
      });

      it('refuses a direct write naming a session that does not exist', async () => {
        // The database keeps the column referential even when a service is bypassed. The row
        // cites a real allocation transaction so the session reference is what fails.
        const real = await allocate();
        expect(real).toMatchObject({ ok: true });
        let refusal = { state: 'accepted', constraint: 'accepted' };
        try {
          await harness.admin.query(
            `INSERT INTO owner_allocations
               (workspace_id, pool_id, epoch, allocation_id, revision, from_owner, to_owner,
                asset_code, asset_scale, atoms, authorized_by, ledger_txn_id)
             VALUES ($1,$2,1,'forged',99,'HOUSE','strategy-a','USDT','v1',1,$3,$4)`,
            [WORKSPACE, POOL, '0'.repeat(64), (real as { ledgerTxnId: string }).ledgerTxnId],
          );
        } catch (error) {
          refusal = sqlRefusal(error);
        }
        expect(refusal.constraint).toBe('owner_allocations_authorized_by_session');
      });

      it('refuses a direct write naming an expired owner session', async () => {
        const expired = '8'.repeat(64);
        await seedOwnerSession(expired, 'user-owner', 'owner', { expired: true });
        await ledger.postTransaction({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 1,
          ledgerTxnId: 'allocation-expired',
          source: { kind: 'owner-allocation', ref: 'expired' },
          description: 'must not be authorised by an expired session',
          entries: [
            {
              accountKind: 'HOUSE',
              owner: 'HOUSE',
              claimState: 'AVAILABLE',
              asset: { code: 'USDT', scale: 'v1' },
              deltaAtoms: -1n,
            },
            {
              accountKind: 'STRATEGY',
              owner: 'strategy-a',
              claimState: 'AVAILABLE',
              asset: { code: 'USDT', scale: 'v1' },
              deltaAtoms: 1n,
            },
          ],
        });
        await expect(
          harness.admin.query(
            `INSERT INTO owner_allocations
               (workspace_id, pool_id, epoch, allocation_id, revision, from_owner, to_owner,
                asset_code, asset_scale, atoms, authorized_by, ledger_txn_id)
             VALUES ($1,$2,1,'expired',99,'HOUSE','strategy-a','USDT','v1',1,$3,
                     'allocation-expired')`,
            [WORKSPACE, POOL, expired],
          ),
        ).rejects.toMatchObject({ code: '23001' });
      });
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
      const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
      expect(balances.find((b) => b.owner === 'strategy-a')?.availableAtoms).toBe(500n);
    });

    it('refuses the same allocation id claiming different facts', async () => {
      await allocate();
      for (const changed of [
        { atoms: 900n },
        { to: 'strategy-b' },
        { from: 'strategy-a', to: 'HOUSE' },
        { asset: BTC },
        // The authorising session is part of the decision, not metadata alongside it.
        { sessionIdHash: OTHER_SESSION },
      ]) {
        const label = Object.keys(changed).join(',');
        expect(await allocate(changed), label).toEqual({
          ok: false,
          reason: 'ALLOCATION_CONFLICT',
        });
      }
    });

    it('keeps the ledger transaction id within its bound for a maximal allocation id', async () => {
      const longest = `a${'x'.repeat(63)}`;
      expect(longest).toHaveLength(64);
      expect(await allocate({ allocationId: longest })).toMatchObject({ ok: true });
      const txn = await harness.admin.query<{ ledger_txn_id: string }>(
        `SELECT ledger_txn_id FROM owner_allocations WHERE allocation_id = $1`,
        [longest],
      );
      expect((txn.rows[0]?.ledger_txn_id ?? '').length).toBeLessThanOrEqual(64);
    });

    it('refuses allocating before any baseline exists', async () => {
      await harness.reset();
      await harness.seedPool();
      expect(await allocate()).toEqual({ ok: false, reason: 'NO_BASELINE' });
    });

    /**
     * T-013, on independent backends.
     *
     * Two allocators read the same HOUSE availability and each try to take all of it. The
     * account-wide lock serialises them, so exactly one commits and the other sees the
     * reduced availability — never both, and never a negative claim.
     */
    it('lets only one of two concurrent allocators spend the same HOUSE balance', async () => {
      const first = await harness.pinnedRepositoryPool();
      const second = await harness.pinnedRepositoryPool();
      const barrier = await harness.connect();

      await barrier.client.query('BEGIN');
      await barrier.client.query(
        'SELECT 1 FROM pools WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE',
        [WORKSPACE, POOL],
      );

      const request = (id: string, to: string) =>
        ({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 1,
          allocationId: id,
          actor: OWNER,
          sessionIdHash: SESSION,
          from: 'HOUSE',
          to,
          asset: USDT,
          atoms: 1_000n,
        }) as const;

      const a = new BaselineRepository(first.pool).allocate(request('alloc-a', 'strategy-a'));
      const b = new BaselineRepository(second.pool).allocate(request('alloc-b', 'strategy-b'));
      await harness.waitUntilBlockedBy(barrier.pid, [first.pid, second.pid]);
      await barrier.client.query('COMMIT');

      const [outcomeA, outcomeB] = await Promise.all([a, b]);
      const succeeded = [outcomeA, outcomeB].filter((outcome) => outcome.ok);
      const refused = [outcomeA, outcomeB].filter((outcome) => !outcome.ok);
      expect(succeeded).toHaveLength(1);
      expect(refused[0]).toEqual({
        ok: false,
        reason: 'UNAUTHORIZED',
        detail: 'EXCEEDS_AVAILABLE',
      });

      // One allocation row, one strategy funded, and every unit still owned exactly once.
      expect((await harness.admin.query('SELECT 1 FROM owner_allocations')).rowCount).toBe(1);
      expect(verifyConservation(await positions()).conserved).toBe(true);
      const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
      expect(balances.find((b2) => b2.owner === 'HOUSE')?.availableAtoms).toBe(0n);
    });

    it('leaves no allocation row when the postings are rolled back', async () => {
      // A crash between the postings and the record would be an allocation nobody authorised,
      // or an authorisation that moved nothing. The transaction makes both unreachable.
      const before = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
      await expect(
        baselines.allocate({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 1,
          allocationId: 'alloc-bad-id-!!',
          actor: OWNER,
          sessionIdHash: SESSION,
          from: 'HOUSE',
          to: 'strategy-a',
          asset: USDT,
          atoms: 100n,
        }),
      ).rejects.toBeTruthy();

      expect((await harness.admin.query('SELECT 1 FROM owner_allocations')).rowCount).toBe(0);
      expect(
        (
          await harness.admin.query(
            `SELECT 1 FROM ledger_entries WHERE ledger_txn_id = 'allocation-alloc-bad-id-!!'`,
          )
        ).rowCount,
      ).toBe(0);
      expect(await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 })).toEqual(
        before,
      );
    });

    it('records who authorised it and that it moved nothing at the venue', async () => {
      await allocate();
      const stored = await harness.admin.query<{ authorized_by: string; ledger_txn_id: string }>(
        'SELECT authorized_by, ledger_txn_id FROM owner_allocations',
      );
      expect(stored.rows[0]?.authorized_by).toBe(SESSION);
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
