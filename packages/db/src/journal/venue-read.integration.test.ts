import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CoverageAssessment } from '@capitaldesk/contracts';
import { VenueReadRepository } from './venue-read.js';
import {
  ACCOUNT,
  DATABASE_URL,
  JournalHarness,
  POOL,
  WORKSPACE,
  sqlRefusal,
} from './test-harness.js';

/**
 * Durable read state, against real PostgreSQL (module 05).
 *
 * A cursor is the only thing standing between a restart and an unprovable window: ADR-0002
 * condition C3 establishes backfill completeness by contiguous cursor pagination, so a cursor
 * that rolled back would let a window be reported as backfilled when the evidence for its tail
 * had been discarded.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

describeIfDatabase('venue read state', () => {
  const harness = new JournalHarness();
  let repository: VenueReadRepository;
  const SCOPE = { workspaceId: WORKSPACE, poolId: POOL, epoch: 1, symbol: 'BTCUSDT' } as const;
  const DIGEST = `sha256:${'a'.repeat(64)}`;

  /**
   * Advance the cursor the way production does: with the page evidence that justifies it.
   *
   * The repository no longer exposes a bare `advance`, because a cursor that moves without
   * durable evidence behind it is the thing `recordPageAndAdvance` exists to prevent.
   */
  function advance(
    scope: { workspaceId: string; poolId: string; epoch: number; symbol: string },
    next: { nextFromId: string; highestTradeId: string; digest: string },
    trades: readonly { id: string; qty: string }[] = [],
  ): ReturnType<VenueReadRepository['recordPageAndAdvance']> {
    return repository.recordPageAndAdvance({
      ...scope,
      trades: trades.map((t) => ({
        venueTradeId: t.id,
        payload: { symbol: scope.symbol, venueTradeId: t.id, baseAtoms: t.qty },
      })),
      cursor: next,
    });
  }

  /** Write one snapshot row directly, for tests of the table's own constraints. */
  function insertSnapshotSql(row: {
    snapshotId: string;
    stableAccountId?: string;
    requestedAt?: string;
    respondedAt?: string;
    responseDigest?: string;
    balances?: unknown;
    epoch?: number;
  }): Promise<unknown> {
    return harness.admin.query(
      `INSERT INTO venue_account_snapshots
         (workspace_id, pool_id, epoch, snapshot_id, stable_account_id, requested_at,
          responded_at, source_time, response_digest, balances)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        WORKSPACE,
        POOL,
        row.epoch ?? 1,
        row.snapshotId,
        row.stableAccountId ?? ACCOUNT.stableAccountId,
        row.requestedAt ?? '2026-09-08T11:00:00.000Z',
        row.respondedAt ?? '2026-09-08T11:00:00.100Z',
        '2026-09-08T10:59:59.000Z',
        row.responseDigest ?? DIGEST,
        JSON.stringify(row.balances ?? [{ asset: 'USDT', freeAtoms: '100', lockedAtoms: '0' }]),
      ],
    );
  }

  /** Write one cut row directly, for tests of the table's own constraints. */
  function insertCutSql(row: Record<string, unknown>): Promise<unknown> {
    return harness.admin.query(
      `INSERT INTO venue_observation_cuts
         (workspace_id, pool_id, epoch, cut_id, window_from, window_to, opening_snapshot_id,
          closing_snapshot_id, coverage_state, detection_scope, unmet, observed_symbols)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
      [
        WORKSPACE,
        POOL,
        1,
        row['cutId'] ?? 'cut-1',
        row['windowFrom'],
        row['windowTo'],
        row['openingSnapshotId'] ?? 'snap-open',
        row['closingSnapshotId'] ?? 'snap-close',
        row['coverageState'] ?? 'INCOMPLETE',
        row['detectionScope'] ?? 'NET_BALANCE_CHANGES_ONLY',
        JSON.stringify(row['unmet'] ?? ['x']),
        JSON.stringify(row['observedSymbols'] ?? ['BTCUSDT']),
      ],
    );
  }

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    repository = new VenueReadRepository(harness.pool);
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  describe('trade cursors', () => {
    it('reports no cursor before the first read, rather than a zero', async () => {
      // "Never read" and "read up to trade 0" are different facts, and only one of them
      // permits treating the range before it as covered.
      expect(await repository.cursor(SCOPE)).toBeNull();
    });

    it('records and reads back a cursor with the digest that advanced it', async () => {
      const advanced = await advance(SCOPE, {
        nextFromId: '13',
        highestTradeId: '12',
        digest: DIGEST,
      });
      expect(advanced).toMatchObject({ ok: true });
      expect(await repository.cursor(SCOPE)).toEqual({
        symbol: 'BTCUSDT',
        nextFromId: '13',
        highestTradeId: '12',
        advancedByDigest: DIGEST,
        version: 1,
      });
    });

    it('survives a restart, which is the whole reason it is durable', async () => {
      await advance(SCOPE, {
        nextFromId: '13',
        highestTradeId: '12',
        digest: DIGEST,
      });
      // A completely fresh repository on the same database: a restarted worker.
      const restarted = new VenueReadRepository(harness.pool);
      expect(await restarted.cursor(SCOPE)).toMatchObject({ nextFromId: '13' });
    });

    it('advances forward and increments its version', async () => {
      await advance(SCOPE, { nextFromId: '13', highestTradeId: '12', digest: DIGEST });
      const again = await advance(SCOPE, {
        nextFromId: '99',
        highestTradeId: '98',
        digest: DIGEST,
      });
      expect(again).toMatchObject({ ok: true, cursor: { nextFromId: '99', version: 2 } });
    });

    it('refuses a rollback with a typed outcome naming both positions', async () => {
      await advance(SCOPE, { nextFromId: '99', highestTradeId: '98', digest: DIGEST });
      expect(
        await advance(SCOPE, {
          nextFromId: '13',
          highestTradeId: '12',
          digest: DIGEST,
        }),
      ).toMatchObject({ ok: false, reason: 'CURSOR_NOT_ADVANCING', stored: '99', proposed: '13' });
      expect(await repository.cursor(SCOPE)).toMatchObject({ nextFromId: '99' });
    });

    it('compares cursors numerically, not as text', async () => {
      // '9' sorts after '10' as a string. A text comparison would accept the rollback below
      // and reject the legitimate advance in the previous case.
      await advance(SCOPE, { nextFromId: '10', highestTradeId: '9', digest: DIGEST });
      expect(
        await advance(SCOPE, { nextFromId: '9', highestTradeId: '8', digest: DIGEST }),
      ).toMatchObject({ ok: false, reason: 'CURSOR_NOT_ADVANCING' });
      expect(
        await advance(SCOPE, {
          nextFromId: '11',
          highestTradeId: '10',
          digest: DIGEST,
        }),
      ).toMatchObject({ ok: true });
    });

    it('refuses an advance to the same position, which records a page that was not read', async () => {
      // An equal cursor rewrote the digest, the highest id and the version, so the evidence
      // trail claimed a page had been read when the position had not moved.
      await advance(SCOPE, { nextFromId: '13', highestTradeId: '12', digest: DIGEST });
      expect(
        await advance(SCOPE, {
          nextFromId: '13',
          highestTradeId: '12',
          digest: DIGEST,
        }),
      ).toMatchObject({ ok: false, reason: 'CURSOR_NOT_ADVANCING', stored: '13', proposed: '13' });
      const stored = await repository.cursor(SCOPE);
      expect(stored?.version).toBe(1);
    });

    it('refuses an equal advance at the table as well', async () => {
      await advance(SCOPE, { nextFromId: '13', highestTradeId: '12', digest: DIGEST });
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await harness.admin.query(`UPDATE venue_trade_cursors SET advanced_by_digest = $1`, [
          `sha256:${'c'.repeat(64)}`,
        ]);
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.state).toBe('23001');
    });

    it('requires the cursor to be exactly one past the highest observed id', async () => {
      // fromId is inclusive. Any other pair either re-reads a booked trade or skips one, and
      // both look like a legitimate cursor afterwards.
      for (const pair of [
        { nextFromId: '13', highestTradeId: '11' },
        { nextFromId: '13', highestTradeId: '13' },
        { nextFromId: '13', highestTradeId: '20' },
      ]) {
        await expect(
          advance(SCOPE, { ...pair, digest: DIGEST }),
          JSON.stringify(pair),
        ).rejects.toThrow(/one past/);
      }
      // The positive control.
      await expect(
        advance(SCOPE, { nextFromId: '13', highestTradeId: '12', digest: DIGEST }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('enforces the +1 invariant at the table too', async () => {
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await harness.admin.query(
          `INSERT INTO venue_trade_cursors
             (workspace_id, pool_id, epoch, symbol, next_from_id, highest_trade_id, advanced_by_digest)
           VALUES ($1, $2, 1, 'BTCUSDT', '13', '11', $3)`,
          [WORKSPACE, POOL, DIGEST],
        );
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.constraint).toBe('venue_trade_cursors_next_is_one_past_highest');
    });

    it('refuses a digest that is not a sha256 reference, in both layers', async () => {
      await expect(
        advance(SCOPE, {
          nextFromId: '13',
          highestTradeId: '12',
          digest: 'trust me',
        }),
      ).rejects.toThrow(/sha256/);
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await harness.admin.query(
          `INSERT INTO venue_trade_cursors
             (workspace_id, pool_id, epoch, symbol, next_from_id, highest_trade_id, advanced_by_digest)
           VALUES ($1, $2, 1, 'BTCUSDT', '13', '12', 'trust me')`,
          [WORKSPACE, POOL],
        );
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.constraint).toBe('venue_trade_cursors_digest_shape');
    });

    it('bounds a cursor to the atom magnitude this system supports', async () => {
      // An unbounded digit string flows through the ::NUMERIC comparison in the forward-only
      // trigger, where an absurd value is a hazard rather than a cursor.
      const tooLong = '1'.repeat(79);
      await expect(
        advance(SCOPE, {
          nextFromId: tooLong,
          highestTradeId: '1'.repeat(78),
          digest: DIGEST,
        }),
      ).rejects.toThrow(/78-digit/);
      // The positive control: exactly at the bound is accepted.
      const atBound = '9'.repeat(77);
      await expect(
        advance(SCOPE, {
          nextFromId: (BigInt(atBound) + 1n).toString(),
          highestTradeId: atBound,
          digest: DIGEST,
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('carries a cursor far beyond the safe integer range', async () => {
      const highest = '90071992547409931234567889';
      const huge = (BigInt(highest) + 1n).toString();
      await advance(SCOPE, {
        nextFromId: huge,
        highestTradeId: highest,
        digest: DIGEST,
      });
      expect(await repository.cursor(SCOPE)).toMatchObject({ nextFromId: huge });
    });

    it('refuses a rollback attempted by a writer that bypasses the repository', async () => {
      await advance(SCOPE, { nextFromId: '99', highestTradeId: '98', digest: DIGEST });
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await harness.admin.query(`UPDATE venue_trade_cursors SET next_from_id = '13'`);
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.state).toBe('23001');
      expect(await repository.cursor(SCOPE)).toMatchObject({ nextFromId: '99' });
    });

    it('refuses a deletion, so a cursor cannot be quietly forgotten', async () => {
      await advance(SCOPE, { nextFromId: '13', highestTradeId: '12', digest: DIGEST });
      let refusal = 'accepted';
      try {
        await harness.admin.query('DELETE FROM venue_trade_cursors');
      } catch (error) {
        refusal = sqlRefusal(error).state;
      }
      expect(refusal).toBe('23001');
    });

    it('refuses a non-canonical cursor at the table as well as in the repository', async () => {
      await expect(
        advance(SCOPE, { nextFromId: '007', highestTradeId: '6', digest: DIGEST }),
      ).rejects.toThrow(TypeError);
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await harness.admin.query(
          `INSERT INTO venue_trade_cursors
             (workspace_id, pool_id, epoch, symbol, next_from_id, highest_trade_id, advanced_by_digest)
           VALUES ($1, $2, 1, 'BTCUSDT', '007', '6', $3)`,
          [WORKSPACE, POOL, DIGEST],
        );
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.constraint).toBe('venue_trade_cursors_from_shape');
    });

    it('keeps cursors separate per symbol and per epoch', async () => {
      // `myTrades` requires a symbol and its ids are per-symbol, so there is no account-wide
      // cursor to keep. A reset opens a new epoch, whose cursor starts unset.
      await advance(SCOPE, { nextFromId: '13', highestTradeId: '12', digest: DIGEST });
      await advance(
        { ...SCOPE, symbol: 'ETHUSDT' },
        { nextFromId: '5', highestTradeId: '4', digest: DIGEST },
      );
      expect((await repository.cursors(SCOPE)).map((cursor) => cursor.symbol)).toEqual([
        'BTCUSDT',
        'ETHUSDT',
      ]);

      // Rotate: only one epoch is current per pool, so epoch 1 closes as epoch 2 opens.
      await harness.admin.query(
        `UPDATE baseline_epochs SET closed_at = now(), closed_reason = 'reset'
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = 1`,
        [WORKSPACE, POOL],
      );
      await harness.admin.query(
        `INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ($1, $2, 2)`,
        [WORKSPACE, POOL],
      );
      expect(await repository.cursor({ ...SCOPE, epoch: 2 })).toBeNull();
    });

    it('refuses a cursor for an epoch that does not exist', async () => {
      expect(
        await advance(
          { ...SCOPE, epoch: 99 },
          { nextFromId: '1', highestTradeId: '0', digest: DIGEST },
        ),
      ).toMatchObject({ ok: false, reason: 'UNKNOWN_EPOCH' });
    });
  });

  /**
   * The same trade delivered twice is one fact. The same trade id carrying different economic
   * content is a contradiction, and the cursor must not move past one — advancing would leave
   * the disputed trade behind a position claiming the range is settled.
   */
  describe('page evidence: duplicate versus corrected', () => {
    const page = (trades: readonly { id: string; qty: string }[], cursor: string | null) => ({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      symbol: 'BTCUSDT',
      trades: trades.map((t) => ({
        venueTradeId: t.id,
        payload: { symbol: 'BTCUSDT', venueTradeId: t.id, baseAtoms: t.qty },
      })),
      cursor:
        cursor === null
          ? null
          : {
              nextFromId: cursor,
              highestTradeId: (BigInt(cursor) - 1n).toString(),
              digest: DIGEST,
            },
    });

    it('records a page and advances', async () => {
      const outcome = await repository.recordPageAndAdvance(
        page(
          [
            { id: '1', qty: '100' },
            { id: '2', qty: '200' },
          ],
          '3',
        ),
      );
      expect(outcome).toMatchObject({ ok: true, recorded: 2, duplicates: 0 });
      expect(await repository.cursor(SCOPE)).toMatchObject({ nextFromId: '3' });
    });

    it('records an identical redelivery once, as a duplicate, and still advances', async () => {
      await repository.recordPageAndAdvance(page([{ id: '1', qty: '100' }], '2'));
      const again = await repository.recordPageAndAdvance(
        page(
          [
            { id: '1', qty: '100' },
            { id: '2', qty: '200' },
          ],
          '3',
        ),
      );
      expect(again).toMatchObject({ ok: true, recorded: 1, duplicates: 1 });
      const rows = await harness.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM raw_observations WHERE kind = 'venue_trade'`,
      );
      expect(rows.rows[0]?.count).toBe('2');
      expect((await harness.admin.query('SELECT 1 FROM evidence_conflicts')).rowCount).toBe(0);
    });

    it('records a contradiction, leaves the stored fact alone, and refuses to advance', async () => {
      await repository.recordPageAndAdvance(page([{ id: '1', qty: '100' }], '2'));
      const corrected = await repository.recordPageAndAdvance(page([{ id: '1', qty: '999' }], '2'));

      expect(corrected).toMatchObject({
        ok: false,
        reason: 'EVIDENCE_CONTRADICTORY',
        conflicts: [{ venueTradeId: '1' }],
      });
      const conflicts = await harness.admin.query<{ subject_ref: string; subject_kind: string }>(
        'SELECT subject_ref, subject_kind FROM evidence_conflicts',
      );
      expect(conflicts.rows[0]).toMatchObject({ subject_ref: 'BTCUSDT:1', subject_kind: 'fill' });
      // Immutable evidence is not rewritten.
      const stored = await harness.admin.query<{ payload: { baseAtoms: string } }>(
        `SELECT payload FROM raw_observations WHERE source_ref = 'BTCUSDT:1'`,
      );
      expect(stored.rows[0]?.payload.baseAtoms).toBe('100');
      // And the cursor stayed where it was, so the incident path has something to come back to.
      expect(await repository.cursor(SCOPE)).toMatchObject({ nextFromId: '2' });
    });

    it('digests each trade on its own bytes, not the page response digest', async () => {
      // Stamping one digest onto every row made two different trades compare equal to each
      // other, and made a corrected record indistinguishable from the original.
      await repository.recordPageAndAdvance(
        page(
          [
            { id: '1', qty: '100' },
            { id: '2', qty: '200' },
          ],
          '3',
        ),
      );
      const digests = await harness.admin.query<{ payload_digest: string }>(
        `SELECT payload_digest FROM raw_observations WHERE kind = 'venue_trade' ORDER BY source_ref`,
      );
      expect(digests.rows[0]?.payload_digest).not.toBe(digests.rows[1]?.payload_digest);
    });

    it('bounds the observation id for a symbol and trade id that would overflow it', async () => {
      // observation_id is capped at 64 characters. Without a bound the insert fails after the
      // page has partly succeeded.
      const long = '9'.repeat(70);
      const outcome = await repository.recordPageAndAdvance({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        symbol: 'BTCUSDT',
        trades: [{ venueTradeId: long, payload: { venueTradeId: long } }],
        cursor: {
          nextFromId: (BigInt(long) + 1n).toString(),
          highestTradeId: long,
          digest: DIGEST,
        },
      });
      expect(outcome).toMatchObject({ ok: true, recorded: 1 });
      const stored = await harness.admin.query<{ observation_id: string }>(
        `SELECT observation_id FROM raw_observations WHERE kind = 'venue_trade'`,
      );
      expect((stored.rows[0]?.observation_id ?? '').length).toBeLessThanOrEqual(64);
    });
  });

  describe('snapshots and cuts', () => {
    const OPENED_AT = '2026-09-08T11:00:00.000Z';
    const CLOSED_AT = '2026-09-08T12:00:00.100Z';

    async function snapshot(
      id: string,
      free = '100',
      requestedAt = OPENED_AT,
      respondedAt = '2026-09-08T11:00:00.100Z',
    ): Promise<void> {
      await insertSnapshotSql({
        snapshotId: id,
        requestedAt,
        respondedAt,
        balances: [{ asset: 'USDT', freeAtoms: free, lockedAtoms: '0' }],
      });
    }

    /** The pair a coherent cut brackets: an opening reading, then a later closing one. */
    async function brackets(): Promise<void> {
      await snapshot('snap-open');
      await snapshot('snap-close', '90', '2026-09-08T12:00:00.000Z', CLOSED_AT);
    }

    it('records a snapshot with its interval, digest and balances', async () => {
      await snapshot('snap-open');
      const stored = await harness.admin.query<{ stable_account_id: string; balances: unknown }>(
        'SELECT stable_account_id, balances FROM venue_account_snapshots',
      );
      expect(stored.rows[0]?.stable_account_id).toBe(ACCOUNT.stableAccountId);
      expect(stored.rows[0]?.balances).toEqual([
        { asset: 'USDT', freeAtoms: '100', lockedAtoms: '0' },
      ]);
    });

    it('refuses a snapshot whose interval runs backwards', async () => {
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await insertSnapshotSql({
          snapshotId: 'snap-bad',
          requestedAt: '2026-09-08T12:00:00.000Z',
          respondedAt: '2026-09-08T11:59:00.000Z',
        });
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.constraint).toBe('venue_account_snapshots_interval_ordered');
    });

    it('refuses a snapshot whose digest is not a sha256 reference', async () => {
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await insertSnapshotSql({ snapshotId: 'snap-bad', responseDigest: 'trust me' });
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.constraint).toBe('venue_account_snapshots_digest_shape');
    });

    it('refuses to change or delete a recorded snapshot', async () => {
      await snapshot('snap-open');
      for (const statement of [
        `UPDATE venue_account_snapshots SET balances = '[]'::jsonb`,
        'DELETE FROM venue_account_snapshots',
      ]) {
        let refusal = 'accepted';
        try {
          await harness.admin.query(statement);
        } catch (error) {
          refusal = sqlRefusal(error).state;
        }
        expect(refusal, statement).toBe('23001');
      }
    });

    async function cut(
      state: CoverageAssessment['state'],
      unmet: string[],
      scope: CoverageAssessment['detectionScope'],
    ): Promise<void> {
      await insertCutSql({
        cutId: `cut-${state}`,
        windowFrom: OPENED_AT,
        windowTo: CLOSED_AT,
        coverageState: state,
        detectionScope: scope,
        unmet,
      });
    }

    it('records a cut with its verdict, reasons and observed symbol set', async () => {
      await brackets();
      await cut('COMPLETE', [], 'FULL_WITHIN_PROVEN_UNIVERSE');
      const stored = await harness.admin.query<{ observed_symbols: unknown; unmet: unknown }>(
        'SELECT observed_symbols, unmet FROM venue_observation_cuts',
      );
      // ADR-0002 condition U: the enumerated symbol set is recorded, not assumed later from
      // whatever configuration happens to be current.
      expect(stored.rows[0]?.observed_symbols).toEqual(['BTCUSDT']);
      expect(stored.rows[0]?.unmet).toEqual([]);
    });

    it('refuses a COMPLETE cut that still lists an unmet condition', async () => {
      await brackets();
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await cut(
          'COMPLETE',
          ['the stream session was interrupted'],
          'FULL_WITHIN_PROVEN_UNIVERSE',
        );
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      // The contradiction that would let a pool dispatch against a window nothing had proven.
      expect(refusal.constraint).toBe('venue_observation_cuts_complete_has_no_unmet');
    });

    it('refuses a COMPLETE cut whose detection scope is only net balance changes', async () => {
      await brackets();
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await cut('COMPLETE', [], 'NET_BALANCE_CHANGES_ONLY');
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.constraint).toBe('venue_observation_cuts_complete_is_fully_scoped');
    });

    it('accepts an UNSUPPORTED cut carrying its reasons', async () => {
      await brackets();
      await cut(
        'UNSUPPORTED',
        ['the account-wide event stream session was interrupted'],
        'NET_BALANCE_CHANGES_ONLY',
      );
      const stored = await harness.admin.query<{ coverage_state: string }>(
        'SELECT coverage_state FROM venue_observation_cuts',
      );
      expect(stored.rows[0]?.coverage_state).toBe('UNSUPPORTED');
    });

    it('refuses a snapshot attributed to an account this pool does not govern', async () => {
      let refusal = 'accepted';
      try {
        await insertSnapshotSql({
          snapshotId: 'snap-foreign',
          stableAccountId: 'some-other-account',
        });
      } catch (error) {
        refusal = sqlRefusal(error).state;
      }
      // Otherwise a reading from one account could be filed as a bracket of another's cut.
      expect(refusal).toBe('23001');
    });

    it('refuses read state written to a closed epoch', async () => {
      // A closed epoch is one a reset invalidated. Writing to it attributes post-reset
      // evidence to the account that existed before.
      await harness.admin.query(
        `UPDATE baseline_epochs SET closed_at = now(), closed_reason = 'reset'
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = 1`,
        [WORKSPACE, POOL],
      );
      expect(
        await advance(SCOPE, {
          nextFromId: '13',
          highestTradeId: '12',
          digest: DIGEST,
        }),
      ).toMatchObject({ ok: false, reason: 'EPOCH_CLOSED' });

      let refusal = 'accepted';
      try {
        await snapshot('snap-closed');
      } catch (error) {
        refusal = sqlRefusal(error).state;
      }
      expect(refusal).toBe('23001');
    });

    it('writes both brackets and the cut atomically, and rolls all three back on failure', async () => {
      const assessment: CoverageAssessment = {
        state: 'COMPLETE',
        unmet: [],
        detectionScope: 'FULL_WITHIN_PROVEN_UNIVERSE',
      };
      // Non-overlapping: the closing reading begins after the opening one finished.
      const bracket = (id: string, requestedAt: string, respondedAt: string) => ({
        snapshotId: id,
        stableAccountId: ACCOUNT.stableAccountId,
        requestedAt,
        respondedAt,
        sourceTime: null,
        responseDigest: DIGEST,
        balances: [{ asset: 'USDT', freeAtoms: '100', lockedAtoms: '0' }],
      });
      const OPEN = ['2026-09-08T11:00:00.000Z', '2026-09-08T11:00:00.100Z'] as const;
      const CLOSE = ['2026-09-08T12:00:00.000Z', '2026-09-08T12:00:00.100Z'] as const;

      await repository.recordAssessedCut({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        cutId: 'cut-atomic',
        opening: bracket('cut-atomic-open', OPEN[0], OPEN[1]),
        closing: bracket('cut-atomic-close', CLOSE[0], CLOSE[1]),
        assessment,
        observedSymbols: ['BTCUSDT'],
      });
      expect((await harness.admin.query('SELECT 1 FROM venue_account_snapshots')).rowCount).toBe(2);
      expect((await harness.admin.query('SELECT 1 FROM venue_observation_cuts')).rowCount).toBe(1);

      // Now a cut the table refuses. Its snapshots must not survive either: a cut with missing
      // snapshots and snapshots nobody drew a conclusion from are both reachable if the writes
      // are separate.
      await expect(
        repository.recordAssessedCut({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 1,
          cutId: 'cut-rejected',
          opening: bracket('cut-rejected-open', OPEN[0], OPEN[1]),
          closing: bracket('cut-rejected-close', CLOSE[0], CLOSE[1]),
          assessment: { ...assessment, unmet: ['a source observation is outside its class'] },
          observedSymbols: ['BTCUSDT'],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(
        (
          await harness.admin.query(
            `SELECT 1 FROM venue_account_snapshots WHERE snapshot_id LIKE 'cut-rejected%'`,
          )
        ).rowCount,
      ).toBe(0);
      expect((await harness.admin.query('SELECT 1 FROM venue_observation_cuts')).rowCount).toBe(1);
    });

    it('refuses a cut whose brackets are not snapshots in the same scope', async () => {
      await snapshot('snap-open');
      // The closing bracket does not exist. The trigger names it before the foreign key does.
      await expect(cut('INCOMPLETE', ['x'], 'NET_BALANCE_CHANGES_ONLY')).rejects.toMatchObject({
        code: '23001',
      });
    });

    /**
     * The foreign keys prove the two snapshots exist in this scope. They say nothing about
     * whether the declared window matches them, so a one-second window over an hour-long pair
     * of readings would read afterwards as a properly bracketed assessment.
     */
    describe('a cut window must be the interval its own brackets describe', () => {
      async function cutWith(overrides: Record<string, unknown>): Promise<void> {
        await insertCutSql({
          cutId: 'cut-window',
          windowFrom: OPENED_AT,
          windowTo: CLOSED_AT,
          openingSnapshotId: 'snap-open',
          closingSnapshotId: 'snap-close',
          ...overrides,
        });
      }

      beforeEach(async () => {
        await brackets();
      });

      it('accepts the window its brackets actually span', async () => {
        await expect(cutWith({})).resolves.toBeUndefined();
      });

      it('refuses a window_from that is not when the opening bracket was requested', async () => {
        await expect(cutWith({ windowFrom: '2026-09-08T10:00:00.000Z' })).rejects.toMatchObject({
          code: '23001',
        });
      });

      it('refuses a window_to that is not when the closing bracket answered', async () => {
        await expect(cutWith({ windowTo: '2026-09-08T23:00:00.000Z' })).rejects.toMatchObject({
          code: '23001',
        });
      });

      it('refuses one snapshot used as both brackets', async () => {
        // A cut that brackets nothing still reads as a bracketed assessment afterwards.
        await expect(
          cutWith({ closingSnapshotId: 'snap-open', windowTo: '2026-09-08T11:00:00.100Z' }),
        ).rejects.toMatchObject({ code: '23001' });
      });

      it('refuses brackets that overlap', async () => {
        // Comparing the two request instants alone allowed a closing reading that began while
        // the opening one was still in flight: the two describe overlapping views of the
        // account, and the interval between them brackets nothing.
        await insertSnapshotSql({
          snapshotId: 'snap-overlap',
          requestedAt: '2026-09-08T11:00:00.050Z',
          respondedAt: '2026-09-08T12:00:00.100Z',
        });
        await expect(
          cutWith({ closingSnapshotId: 'snap-overlap', windowTo: '2026-09-08T12:00:00.100Z' }),
        ).rejects.toMatchObject({ code: '23001' });
      });

      it('accepts brackets that merely touch, which a fast pair really produces', async () => {
        // The positive control: the closing reading beginning exactly when the opening one
        // finished is adjacent, not overlapping.
        await insertSnapshotSql({
          snapshotId: 'snap-adjacent',
          requestedAt: '2026-09-08T11:00:00.100Z',
          respondedAt: '2026-09-08T11:30:00.000Z',
        });
        await expect(
          cutWith({ closingSnapshotId: 'snap-adjacent', windowTo: '2026-09-08T11:30:00.000Z' }),
        ).resolves.not.toThrow();
      });

      it('refuses brackets in the wrong order', async () => {
        await expect(
          cutWith({
            openingSnapshotId: 'snap-close',
            closingSnapshotId: 'snap-open',
            windowFrom: '2026-09-08T12:00:00.000Z',
            windowTo: '2026-09-08T11:00:00.100Z',
          }),
        ).rejects.toMatchObject({ code: '23001' });
      });
    });
  });
});
