import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DISPATCH_ATTEMPT_TRANSITIONS } from '@capitaldesk/contracts';
import { DispatchRepository } from './dispatch.js';
import { LedgerRepository } from './ledger.js';
import {
  DATABASE_URL,
  JournalHarness,
  POOL,
  USDT,
  WORKSPACE,
  sqlRefusal,
  sqlState,
} from './test-harness.js';

/**
 * Blocker 2 of the maintainer's fourth exact-head review of PR #2.
 *
 * `NOT_SENT_PROVEN` is the one dispatch outcome that releases a held reservation, so it is
 * the one that must not be reachable on anybody's word. At the reviewed head it was reachable
 * two ways: a raw UPDATE moved DISPATCH_MARKED straight into it with no evidence at all, and
 * `DispatchRepository.resolve` accepted four caller-supplied booleans, checked they were
 * true, and discarded them - nothing stored, nothing referencing a real observation, nothing
 * a later reader could audit.
 *
 * The fail-closed answer for module 04: the state stays in the domain contract, and nothing
 * can reach it. The evidence ADR-0001 requires is produced by the reconciler in module 15,
 * and binding it needs columns that reference durable evidence rows, which a forward
 * migration will add. Until then both the repository and the database refuse.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const HOST = { bootId: 'boot-1', pid: 42, processStartedAt: new Date('2026-09-08T00:00:00Z') };

describe('the non-send outcome stays in the domain contract', () => {
  it('is still a reachable state in the state machine the executor reasons about', () => {
    // Deleting it from the contract would be the other kind of dishonesty: the outcome exists
    // in the domain, and module 15 will implement it. What module 04 refuses is reaching it.
    expect(DISPATCH_ATTEMPT_TRANSITIONS['DISPATCH_MARKED']).toContain('NOT_SENT_PROVEN');
    expect(DISPATCH_ATTEMPT_TRANSITIONS['UNKNOWN']).toContain('NOT_SENT_PROVEN');
    // Never directly from a send that was attempted, by the table alone.
    expect(DISPATCH_ATTEMPT_TRANSITIONS['SEND_ATTEMPTED']).not.toContain('NOT_SENT_PROVEN');
  });
});

describeIfDatabase('nothing in module 04 can reach NOT_SENT_PROVEN', () => {
  const harness = new JournalHarness();
  let dispatch: DispatchRepository;
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
    dispatch = new DispatchRepository(harness.pool);
    ledger = new LedgerRepository(harness.pool);
    await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-bootstrap',
      source: { kind: 'bootstrap', ref: 'round-4' },
      description: 'baseline',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: 20_000n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 20_000n,
        },
      ],
    });
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      payload: { child: 'BUY' },
      payloadDigest: 'digest-1',
      state: 'DISPATCH_PENDING',
    });
    await ledger.reserve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reservationId: 'res-1',
      strategyId: 'strategy-a',
      planId: 'plan-1',
      asset: USDT,
      atoms: 5_000n,
    });
    await dispatch.prepare({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      attemptId: 'a1',
      clientOrderId: 'client-1',
      dispatchToken: 'token-1',
    });
    await dispatch.mark({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'a1',
      outboxId: 'ob-1',
      signedRequest: { timestamp: 1 },
      host: HOST,
    });
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  /** State, reservation and balances: what a forged release would have moved. */
  async function liability(): Promise<Record<string, string | null>> {
    const result = await harness.admin.query<Record<string, string | null>>(
      `SELECT (SELECT state FROM dispatch_attempts WHERE attempt_id = 'a1') AS attempt_state,
              (SELECT resolved_at::text FROM dispatch_attempts WHERE attempt_id = 'a1') AS resolved_at,
              (SELECT state FROM reservations WHERE reservation_id = 'res-1') AS reservation_state,
              (SELECT coalesce(sum(delta_atoms), 0)::text FROM ledger_entries
                WHERE claim_state = 'RESERVED') AS reserved,
              (SELECT coalesce(sum(delta_atoms), 0)::text FROM ledger_entries
                WHERE claim_state = 'AVAILABLE' AND account_owner = 'strategy-a') AS available,
              (SELECT ledger_revision::text FROM pools
                WHERE workspace_id = $1 AND pool_id = $2) AS revision`,
      [WORKSPACE, POOL],
    );
    return result.rows[0] ?? {};
  }

  const HELD = {
    attempt_state: 'DISPATCH_MARKED',
    resolved_at: null,
    reservation_state: 'HELD',
    reserved: '5000',
    available: '15000',
    revision: '2',
  };

  it('refuses the repository transition and leaves the liability exactly as it was', async () => {
    expect(await liability()).toEqual(HELD);
    expect(
      await dispatch.resolve({
        workspaceId: WORKSPACE,
        poolId: POOL,
        attemptId: 'a1',
        to: 'NOT_SENT_PROVEN',
      }),
    ).toEqual({ ok: false, reason: 'NOT_SENT_PROVEN_UNAVAILABLE' });
    expect(await liability()).toEqual(HELD);
  });

  it('refuses a raw UPDATE from DISPATCH_MARKED, which is how the review reached it', async () => {
    let refusal = 'accepted';
    try {
      await harness.admin.query(
        `UPDATE dispatch_attempts SET state = 'NOT_SENT_PROVEN', resolved_at = now()
          WHERE attempt_id = 'a1'`,
      );
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23001');
    expect(await liability()).toEqual(HELD);
  });

  it('refuses a raw UPDATE from UNKNOWN as well', async () => {
    expect(
      await dispatch.resolve({
        workspaceId: WORKSPACE,
        poolId: POOL,
        attemptId: 'a1',
        to: 'UNKNOWN',
      }),
    ).toEqual({ ok: true });

    let refusal = 'accepted';
    try {
      await harness.admin.query(
        `UPDATE dispatch_attempts SET state = 'NOT_SENT_PROVEN' WHERE attempt_id = 'a1'`,
      );
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23001');
    expect(await liability()).toEqual({ ...HELD, attempt_state: 'UNKNOWN' });
  });

  it('refuses a fully populated INSERT that starts an attempt already in the state', async () => {
    // The transition trigger fires on UPDATE and cannot see a row that arrives already in the
    // state. The first version of this case supplied no signed request and no marker fields,
    // so `dispatch_attempts_marked_has_evidence` rejected it for having no marker at all and
    // the case passed without ever reaching the fail-closed guard. A row carrying fabricated
    // evidence-shaped values satisfied every other constraint and was accepted.
    //
    // So this supplies every field the other constraints require - a jsonb-object signed
    // request, marked_at, resolved_at, and all three marker host fields - and asserts which
    // constraint refuses it by name.
    const before = await harness.admin.query('SELECT 1 FROM dispatch_attempts');
    let refusal = { state: 'accepted', constraint: 'accepted' };
    try {
      await harness.admin.query(
        `INSERT INTO dispatch_attempts
           (workspace_id, pool_id, epoch, attempt_id, plan_id, client_order_id,
            dispatch_token, state, marked_at, resolved_at, signed_request,
            marker_host_boot_id, marker_pid, marker_process_started_at)
         VALUES ($1, $2, 1, 'a-forged', 'plan-1', 'client-forged',
                 'token-forged', 'NOT_SENT_PROVEN', now(), now(), '{}'::jsonb,
                 'forged-boot', 99, now())`,
        [WORKSPACE, POOL],
      );
    } catch (error) {
      refusal = sqlRefusal(error);
    }
    expect(refusal).toEqual({
      state: '23514',
      constraint: 'dispatch_attempts_not_sent_unreachable',
    });
    // No new row, and the existing attempt untouched.
    expect((await harness.admin.query('SELECT 1 FROM dispatch_attempts')).rowCount).toBe(
      before.rowCount,
    );
    expect(
      (await harness.admin.query(`SELECT 1 FROM dispatch_attempts WHERE attempt_id = 'a-forged'`))
        .rowCount,
    ).toBe(0);
    expect(await liability()).toEqual(HELD);
  });

  it('refuses an INSERT with no marker evidence for the marker reason, not this one', async () => {
    // The positive control for the case above: a row with no marker fields is refused by the
    // marker-evidence constraint. Both constraints exist and each refuses what it is for.
    let refusal = { state: 'accepted', constraint: 'accepted' };
    try {
      await harness.admin.query(
        `INSERT INTO dispatch_attempts
           (workspace_id, pool_id, epoch, attempt_id, plan_id, client_order_id,
            dispatch_token, state, marked_at)
         VALUES ($1, $2, 1, 'a-bare', 'plan-1', 'client-bare', 'token-bare',
                 'DISPATCH_MARKED', now())`,
        [WORKSPACE, POOL],
      );
    } catch (error) {
      refusal = sqlRefusal(error);
    }
    expect(refusal).toEqual({
      state: '23514',
      constraint: 'dispatch_attempts_marked_has_evidence',
    });
  });

  it('refuses an UPDATE into the state even with the transition trigger disabled', async () => {
    // The trigger is the diagnostic; the constraint is the guarantee. A session that disables
    // triggers - replication or a maintenance session - must still not be able to store the
    // state.
    await harness.admin.query(
      'ALTER TABLE dispatch_attempts DISABLE TRIGGER dispatch_attempts_move_forward_only',
    );
    let refusal = { state: 'accepted', constraint: 'accepted' };
    try {
      await harness.admin.query(
        `UPDATE dispatch_attempts SET state = 'NOT_SENT_PROVEN', resolved_at = now()
          WHERE attempt_id = 'a1'`,
      );
    } catch (error) {
      refusal = sqlRefusal(error);
    } finally {
      await harness.admin.query(
        'ALTER TABLE dispatch_attempts ENABLE TRIGGER dispatch_attempts_move_forward_only',
      );
    }
    expect(refusal).toEqual({
      state: '23514',
      constraint: 'dispatch_attempts_not_sent_unreachable',
    });
    expect(await liability()).toEqual(HELD);
  });

  it('still resolves the outcomes module 04 can actually evidence', async () => {
    // The refusal is specific to the unproven non-send, not a freeze of the whole path.
    await dispatch.recordSendAttempted({ workspaceId: WORKSPACE, poolId: POOL, attemptId: 'a1' });
    expect(
      await dispatch.resolve({
        workspaceId: WORKSPACE,
        poolId: POOL,
        attemptId: 'a1',
        to: 'ACKNOWLEDGED',
      }),
    ).toEqual({ ok: true });
    const attempt = await harness.admin.query<{ state: string; resolved_at: Date | null }>(
      `SELECT state, resolved_at FROM dispatch_attempts WHERE attempt_id = 'a1'`,
    );
    expect(attempt.rows[0]?.state).toBe('ACKNOWLEDGED');
    expect(attempt.rows[0]?.resolved_at).not.toBeNull();
  });
});
