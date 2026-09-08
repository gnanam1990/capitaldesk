import type { Pool } from 'pg';
import { LedgerRepository } from './ledger.js';
import { serializable } from './transaction.js';

/**
 * The posture a restored deployment starts in (T-035; ADR-0005 section 4).
 *
 * Every pool is HALTED. Nothing in the old outbox is drained: every unpublished message is
 * quarantined, so a restored copy cannot replay a send it finds waiting. A sealed plan that
 * never reached its marker is invalidated and its reservations released - the world it was
 * approved against no longer exists. A plan that did reach its marker is a liability, and is
 * left exactly as it was, reservation and all, for the reconciler.
 */

export interface RestorePosture {
  readonly poolsHalted: number;
  readonly outboxQuarantined: number;
  readonly plansInvalidated: number;
  readonly reservationsReleased: number;
  /** Attempts still carrying uncertainty or unresolved liability. Untouched, counted. */
  readonly liabilitiesRetained: number;
}

const UNMARKED_IN_FLIGHT = ['SEALED_AWAITING_APPROVAL', 'APPROVED', 'DISPATCH_PENDING'];
const MARKED_STATES = [
  'DISPATCH_MARKED',
  'SEND_ATTEMPTED',
  'UNKNOWN',
  'ACKNOWLEDGED',
  'REJECTED',
  'NOT_SENT_PROVEN',
  'IRRECOVERABLE_UNCERTAINTY',
];
const LIABILITY_STATES = [
  'DISPATCH_MARKED',
  'SEND_ATTEMPTED',
  'UNKNOWN',
  'IRRECOVERABLE_UNCERTAINTY',
];

export function enterRestorePosture(
  pool: Pool,
  input: { readonly reason: string; readonly now: Date },
): Promise<RestorePosture> {
  return serializable(pool, async (client): Promise<RestorePosture> => {
    const halted = await client.query(
      `UPDATE pools SET state = 'HALTED', version = version + 1, updated_at = $1 WHERE state <> 'HALTED'`,
      [input.now],
    );

    const quarantined = await client.query(
      `UPDATE outbox SET quarantined_at = $1, leased_by = NULL, leased_until = NULL
        WHERE published_at IS NULL AND dead_lettered_at IS NULL AND quarantined_at IS NULL`,
      [input.now],
    );

    // Unmarked plans: sealed, approved or pending, with no attempt that reached the marker.
    const stale = await client.query<{ workspace_id: string; pool_id: string; plan_id: string }>(
      `SELECT p.workspace_id, p.pool_id, p.plan_id FROM plans p
        WHERE p.state = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM dispatch_attempts a
             WHERE a.workspace_id = p.workspace_id AND a.pool_id = p.pool_id AND a.plan_id = p.plan_id
               AND a.state = ANY($2::text[]))
        ORDER BY p.workspace_id, p.pool_id, p.plan_id
        FOR UPDATE`,
      [UNMARKED_IN_FLIGHT, MARKED_STATES],
    );

    let reservationsReleased = 0;
    for (const plan of stale.rows) {
      const held = await client.query<{ reservation_id: string; reserved_atoms: string }>(
        `SELECT reservation_id, reserved_atoms::text FROM reservations
          WHERE workspace_id = $1 AND pool_id = $2 AND plan_id = $3 AND state = 'HELD'
          ORDER BY reservation_id FOR UPDATE`,
        [plan.workspace_id, plan.pool_id, plan.plan_id],
      );
      for (const reservation of held.rows) {
        const released = await LedgerRepository.releaseOn(client, {
          workspaceId: plan.workspace_id,
          poolId: plan.pool_id,
          reservationId: reservation.reservation_id,
          atoms: BigInt(reservation.reserved_atoms),
          source: { kind: 'restore-release', ref: reservation.reservation_id },
        });
        if (!released.ok)
          throw new Error(
            `restore could not release ${reservation.reservation_id}: ${released.reason}`,
          );
        reservationsReleased += 1;
      }
      await client.query(
        `UPDATE plans SET state = 'INVALIDATED', version = version + 1, updated_at = $4
          WHERE workspace_id = $1 AND pool_id = $2 AND plan_id = $3`,
        [plan.workspace_id, plan.pool_id, plan.plan_id, input.now],
      );
    }

    const liabilities = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dispatch_attempts WHERE state = ANY($1::text[])`,
      [LIABILITY_STATES],
    );

    return {
      poolsHalted: halted.rowCount ?? 0,
      outboxQuarantined: quarantined.rowCount ?? 0,
      plansInvalidated: stale.rowCount ?? 0,
      reservationsReleased,
      liabilitiesRetained: Number(liabilities.rows[0]?.count ?? '0'),
    };
  });
}
