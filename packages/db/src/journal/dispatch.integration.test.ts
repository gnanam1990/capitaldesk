import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DISPATCH_ATTEMPT_TRANSITIONS } from '@capitaldesk/contracts';
import { DispatchRepository } from './dispatch.js';
import {
  DATABASE_URL,
  JournalHarness,
  MIGRATIONS_DIR,
  POOL,
  WORKSPACE,
  sqlState,
} from './test-harness.js';

/**
 * The dispatch marker (T-024, INV-09).
 *
 * The marker, the client order id and the outbox message that will carry the send commit
 * together or not at all, before any network byte. A marked attempt only moves forward: no
 * method resets it, and the database refuses a regression from any writer.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

describe('dispatch transition table', () => {
  it('is the same table in SQL as in the contracts package', () => {
    // The trigger hardcodes the transitions. If states.ts changes and this file does not,
    // the database enforces a different machine from the one the executor reasons about.
    const sql = readFileSync(path.join(MIGRATIONS_DIR, '0003_journal.sql'), 'utf8');
    const body = sql.slice(
      sql.indexOf('refuse_dispatch_regression'),
      sql.indexOf('dispatch_attempts_move_forward_only'),
    );
    for (const [from, targets] of Object.entries(DISPATCH_ATTEMPT_TRANSITIONS)) {
      if (targets.length === 0) {
        expect(body, `${from} must not appear as a source state`).not.toMatch(
          new RegExp(`WHEN '${from}'`),
        );
        continue;
      }
      const line = body.match(new RegExp(`WHEN '${from}'\\s+THEN NEW\\.state IN \\(([^)]*)\\)`));
      expect(line, `SQL branch for ${from}`).not.toBeNull();
      const sqlTargets = (line?.[1] ?? '')
        .split(',')
        .map((target) => target.trim().replace(/'/g, ''))
        .sort();
      expect(sqlTargets, from).toEqual([...targets].sort());
    }
  });
});

describeIfDatabase('dispatch attempts', () => {
  const harness = new JournalHarness();
  let dispatch: DispatchRepository;

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
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      payload: { child: 'BUY' },
      payloadDigest: 'digest-1',
      state: 'DISPATCH_PENDING',
    });
    await dispatch.prepare({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      attemptId: 'attempt-1',
      clientOrderId: 'cd-attempt-1',
      dispatchToken: 'token-1',
    });
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  const mark = (hooks?: { afterMarkerWrite?: () => Promise<void> }) =>
    dispatch.mark(
      {
        workspaceId: WORKSPACE,
        poolId: POOL,
        attemptId: 'attempt-1',
        outboxId: 'outbox-1',
        signedRequest: { timestamp: 1, recvWindow: 5000 },
        host: { bootId: 'boot-1', pid: 42 },
      },
      hooks,
    );

  it('commits the marker, its identity and the send message together', async () => {
    await mark();
    const attempt = await harness.admin.query<{
      state: string;
      client_order_id: string;
      marked_at: Date | null;
    }>(`SELECT state, client_order_id, marked_at FROM dispatch_attempts`);
    expect(attempt.rows[0]).toMatchObject({
      state: 'DISPATCH_MARKED',
      client_order_id: 'cd-attempt-1',
    });
    expect(attempt.rows[0]?.marked_at).not.toBeNull();
    const outbox = await harness.admin.query<{ kind: string; max_attempts: number }>(
      `SELECT kind, max_attempts FROM outbox`,
    );
    expect(outbox.rows).toEqual([{ kind: 'dispatch.send', max_attempts: 1 }]);
  });

  it('leaves no marker and no message when the transaction fails after the marker write', async () => {
    await expect(
      mark({
        afterMarkerWrite: () => Promise.reject(new Error('injected failure')),
      }),
    ).rejects.toThrow('injected failure');
    const attempt = await harness.admin.query<{ state: string }>(
      'SELECT state FROM dispatch_attempts',
    );
    expect(attempt.rows[0]?.state).toBe('PREPARED');
    expect((await harness.admin.query('SELECT 1 FROM outbox')).rowCount).toBe(0);
  });

  it('records the send as a second durable write, and only after the marker', async () => {
    // SEND_ATTEMPTED is the write immediately before the first network byte (ADR-0001). It
    // cannot precede the marker.
    const early = await dispatch.recordSendAttempted({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
    });
    expect(early).toEqual({ ok: false, reason: 'NOT_MARKED' });
    await mark();
    expect(
      await dispatch.recordSendAttempted({
        workspaceId: WORKSPACE,
        poolId: POOL,
        attemptId: 'attempt-1',
      }),
    ).toEqual({
      ok: true,
    });
    const row = await harness.admin.query<{ state: string; send_attempted_at: Date | null }>(
      'SELECT state, send_attempted_at FROM dispatch_attempts',
    );
    expect(row.rows[0]?.state).toBe('SEND_ATTEMPTED');
    expect(row.rows[0]?.send_attempted_at).not.toBeNull();
  });

  it('can only move a marked attempt forward, from any writer', async () => {
    await mark();
    // The repository has no reset. The database refuses one anyway.
    for (const statement of [
      `UPDATE dispatch_attempts SET state = 'PREPARED'`,
      `UPDATE dispatch_attempts SET client_order_id = 'cd-other'`,
      `UPDATE dispatch_attempts SET dispatch_token = 'tok-other'`,
      `UPDATE dispatch_attempts SET marked_at = now() + interval '1 hour'`,
      `UPDATE dispatch_attempts SET signed_request = '{"timestamp": 2}'::jsonb`,
      `DELETE FROM dispatch_attempts`,
    ]) {
      let refusal = 'accepted';
      try {
        await harness.admin.query(statement);
      } catch (error) {
        refusal = sqlState(error);
      }
      expect(refusal, statement).toBe('23001');
    }
    // And UNKNOWN resolves only to what the contract allows.
    await dispatch.resolve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
      to: 'UNKNOWN',
    });
    expect(
      await dispatch.resolve({
        workspaceId: WORKSPACE,
        poolId: POOL,
        attemptId: 'attempt-1',
        to: 'SEND_ATTEMPTED',
      }),
    ).toMatchObject({ ok: false, reason: 'TRANSITION_REFUSED' });
  });

  it('never reuses a client order id, even for a different plan in a different epoch', async () => {
    await mark();
    await dispatch.resolve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
      to: 'UNKNOWN',
    });
    await dispatch.resolve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
      to: 'IRRECOVERABLE_UNCERTAINTY',
    });
    // A later attempt for a new plan cannot present the same client id: local history keeps
    // it forever, whatever the venue does with closed orders.
    await harness.admin.query(`UPDATE plans SET state = 'MANUAL_REVIEW'`);
    await harness.admin.query(`UPDATE plans SET state = 'UNFILLED'`);
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-2',
      payload: {},
      payloadDigest: 'd2',
      state: 'DISPATCH_PENDING',
    });
    const reused = await dispatch.prepare({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-2',
      attemptId: 'attempt-2',
      clientOrderId: 'cd-attempt-1',
      dispatchToken: 'token-2',
    });
    expect(reused).toEqual({ ok: false, reason: 'CLIENT_ORDER_ID_REUSED' });
  });

  it('permits one in-flight plan per pool', async () => {
    const second = await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-2',
      payload: {},
      payloadDigest: 'd2',
      state: 'SEALED_AWAITING_APPROVAL',
    });
    expect(second).toEqual({ ok: false, reason: 'PLAN_IN_FLIGHT', inFlightPlanId: 'plan-1' });
  });

  it('keeps a sealed payload immutable while its state advances', async () => {
    let refusal = 'accepted';
    try {
      await harness.admin.query(`UPDATE plans SET payload = '{"child":"SELL"}'::jsonb`);
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23001');
    expect(
      await dispatch.transitionPlan({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-1',
        to: 'EXECUTING',
        expectedVersion: 1,
      }),
    ).toEqual({ ok: true, version: 2 });
    expect(
      await dispatch.transitionPlan({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-1',
        to: 'RECONCILING',
        expectedVersion: 1,
      }),
    ).toEqual({ ok: false, reason: 'VERSION_MISMATCH', currentVersion: 2 });
    expect(
      await dispatch.transitionPlan({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-1',
        to: 'PREVIEW',
        expectedVersion: 2,
      }),
    ).toEqual({ ok: false, reason: 'TRANSITION_REFUSED', from: 'EXECUTING' });
  });
});
