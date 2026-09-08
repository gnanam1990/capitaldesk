import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VenueReadRepository } from './venue-read.js';
import { DATABASE_URL, JournalHarness, POOL, WORKSPACE, sqlRefusal } from './test-harness.js';

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
      const advanced = await repository.advance(SCOPE, {
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
      await repository.advance(SCOPE, {
        nextFromId: '13',
        highestTradeId: '12',
        digest: DIGEST,
      });
      // A completely fresh repository on the same database: a restarted worker.
      const restarted = new VenueReadRepository(harness.pool);
      expect(await restarted.cursor(SCOPE)).toMatchObject({ nextFromId: '13' });
    });

    it('advances forward and increments its version', async () => {
      await repository.advance(SCOPE, { nextFromId: '13', highestTradeId: '12', digest: DIGEST });
      const again = await repository.advance(SCOPE, {
        nextFromId: '99',
        highestTradeId: '98',
        digest: DIGEST,
      });
      expect(again).toMatchObject({ ok: true, cursor: { nextFromId: '99', version: 2 } });
    });

    it('refuses a rollback with a typed outcome naming both positions', async () => {
      await repository.advance(SCOPE, { nextFromId: '99', highestTradeId: '98', digest: DIGEST });
      expect(
        await repository.advance(SCOPE, {
          nextFromId: '13',
          highestTradeId: '12',
          digest: DIGEST,
        }),
      ).toEqual({ ok: false, reason: 'CURSOR_NOT_ADVANCING', stored: '99', proposed: '13' });
      expect(await repository.cursor(SCOPE)).toMatchObject({ nextFromId: '99' });
    });

    it('compares cursors numerically, not as text', async () => {
      // '9' sorts after '10' as a string. A text comparison would accept the rollback below
      // and reject the legitimate advance in the previous case.
      await repository.advance(SCOPE, { nextFromId: '10', highestTradeId: '9', digest: DIGEST });
      expect(
        await repository.advance(SCOPE, { nextFromId: '9', highestTradeId: '8', digest: DIGEST }),
      ).toMatchObject({ ok: false, reason: 'CURSOR_NOT_ADVANCING' });
      expect(
        await repository.advance(SCOPE, {
          nextFromId: '11',
          highestTradeId: '10',
          digest: DIGEST,
        }),
      ).toMatchObject({ ok: true });
    });

    it('accepts an advance to the same position, which a repeated empty page produces', async () => {
      await repository.advance(SCOPE, { nextFromId: '13', highestTradeId: '12', digest: DIGEST });
      expect(
        await repository.advance(SCOPE, {
          nextFromId: '13',
          highestTradeId: '12',
          digest: DIGEST,
        }),
      ).toMatchObject({ ok: true });
    });

    it('carries a cursor far beyond the safe integer range', async () => {
      const huge = '90071992547409931234567890';
      await repository.advance(SCOPE, {
        nextFromId: huge,
        highestTradeId: '90071992547409931234567889',
        digest: DIGEST,
      });
      expect(await repository.cursor(SCOPE)).toMatchObject({ nextFromId: huge });
    });

    it('refuses a rollback attempted by a writer that bypasses the repository', async () => {
      await repository.advance(SCOPE, { nextFromId: '99', highestTradeId: '98', digest: DIGEST });
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
      await repository.advance(SCOPE, { nextFromId: '13', highestTradeId: '12', digest: DIGEST });
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
        repository.advance(SCOPE, { nextFromId: '007', highestTradeId: '6', digest: DIGEST }),
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
      await repository.advance(SCOPE, { nextFromId: '13', highestTradeId: '12', digest: DIGEST });
      await repository.advance(
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
        await repository.advance(
          { ...SCOPE, epoch: 99 },
          { nextFromId: '1', highestTradeId: '0', digest: DIGEST },
        ),
      ).toEqual({ ok: false, reason: 'UNKNOWN_EPOCH' });
    });
  });

  describe('snapshots and cuts', () => {
    async function snapshot(id: string, free = '100'): Promise<void> {
      await repository.recordSnapshot({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        snapshotId: id,
        stableAccountId: '354937868',
        requestedAt: '2026-09-08T12:00:00.000Z',
        respondedAt: '2026-09-08T12:00:00.100Z',
        sourceTime: '2026-09-08T11:59:59.000Z',
        responseDigest: DIGEST,
        balances: [{ asset: 'USDT', freeAtoms: free, lockedAtoms: '0' }],
      });
    }

    it('records a snapshot with its interval, digest and balances', async () => {
      await snapshot('snap-open');
      const stored = await harness.admin.query<{ stable_account_id: string; balances: unknown }>(
        'SELECT stable_account_id, balances FROM venue_account_snapshots',
      );
      expect(stored.rows[0]?.stable_account_id).toBe('354937868');
      expect(stored.rows[0]?.balances).toEqual([
        { asset: 'USDT', freeAtoms: '100', lockedAtoms: '0' },
      ]);
    });

    it('refuses a snapshot whose interval runs backwards', async () => {
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await repository.recordSnapshot({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 1,
          snapshotId: 'snap-bad',
          stableAccountId: '354937868',
          requestedAt: '2026-09-08T12:00:00.000Z',
          respondedAt: '2026-09-08T11:59:00.000Z',
          sourceTime: null,
          responseDigest: DIGEST,
          balances: [],
        });
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.constraint).toBe('venue_account_snapshots_interval_ordered');
    });

    it('refuses a snapshot whose digest is not a sha256 reference', async () => {
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await repository.recordSnapshot({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 1,
          snapshotId: 'snap-bad',
          stableAccountId: '354937868',
          requestedAt: '2026-09-08T12:00:00.000Z',
          respondedAt: '2026-09-08T12:00:01.000Z',
          sourceTime: null,
          responseDigest: 'trust me',
          balances: [],
        });
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

    async function cut(state: string, unmet: string[], scope: string): Promise<void> {
      await repository.recordCut({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        cutId: `cut-${state}`,
        windowFrom: '2026-09-08T11:00:00.000Z',
        windowTo: '2026-09-08T12:00:00.000Z',
        openingSnapshotId: 'snap-open',
        closingSnapshotId: 'snap-close',
        coverageState: state,
        detectionScope: scope,
        unmet,
        observedSymbols: ['BTCUSDT'],
      });
    }

    it('records a cut with its verdict, reasons and observed symbol set', async () => {
      await snapshot('snap-open');
      await snapshot('snap-close', '90');
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
      await snapshot('snap-open');
      await snapshot('snap-close', '90');
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
      await snapshot('snap-open');
      await snapshot('snap-close', '90');
      let refusal = { state: 'accepted', constraint: 'accepted' };
      try {
        await cut('COMPLETE', [], 'NET_BALANCE_CHANGES_ONLY');
      } catch (error) {
        refusal = sqlRefusal(error);
      }
      expect(refusal.constraint).toBe('venue_observation_cuts_complete_is_fully_scoped');
    });

    it('accepts an UNSUPPORTED cut carrying its reasons', async () => {
      await snapshot('snap-open');
      await snapshot('snap-close', '90');
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

    it('refuses a cut whose brackets are not snapshots in the same scope', async () => {
      await snapshot('snap-open');
      await expect(cut('INCOMPLETE', ['x'], 'NET_BALANCE_CHANGES_ONLY')).rejects.toMatchObject({
        code: '23503',
      });
    });
  });
});
