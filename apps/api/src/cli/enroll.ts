import { randomBytes } from 'node:crypto';
import type { Client } from 'pg';
import { hashHumanSecret, verifyHumanSecret } from '../auth/secrets.js';
import { type AuditDetail, sanitizeAuditDetail } from '../auth/audit-detail.js';

/**
 * One-time owner enrollment.
 *
 * There is no default owner, no default password and no shared bootstrap secret. An operator
 * with database access issues a single-use code, which is printed once to their terminal;
 * only its Argon2id digest is stored. The code is then redeemed once to create the owner.
 *
 * No email, SMTP, OAuth or SMS is involved, and none is needed: for a single-owner console
 * those would add an external dependency and a second account-recovery attack surface to
 * solve a problem the operator can solve at the terminal they already have.
 *
 * TOTP is deliberately not implemented here. It needs no external service and is a reasonable
 * next step, but it is not required by the governing specs for this milestone; it is recorded
 * as a limitation in ADR-0012 rather than left implicit.
 *
 * Every function below is the enforcement point, not a convenience wrapper around one. The
 * CLI parser validates its own input too, but a direct caller of these functions gets the
 * same refusals: policy that lives only in an argument parser is policy that a second caller
 * silently removes.
 */

export const CODE_LIFETIME_MS = 15 * 60 * 1000;
const MINIMUM_PASSWORD_LENGTH = 12;
const MAXIMUM_PASSWORD_LENGTH = 256;
const MINIMUM_DISTINCT_CHARACTERS = 6;
/** Mirrors users_login_shape / owner_enrollments_login_shape so the refusal is ours, not a 23514. */
const LOGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export type PolicyRefusal = 'INVALID_LOGIN_NAME' | 'WEAK_PASSWORD';

function loginNameRefusal(loginName: string): PolicyRefusal | null {
  return LOGIN_NAME_PATTERN.test(loginName) ? null : 'INVALID_LOGIN_NAME';
}

/**
 * Refuse a password we should never hash.
 *
 * Argon2id will happily digest an empty string, and the resulting row is indistinguishable
 * from a real credential. The distinct-character floor rejects the padding that defeats a
 * pure length rule ("aaaaaaaaaaaa"). This is a floor, not a strength estimate: it is not a
 * substitute for the owner choosing a password a generator produced.
 */
function passwordRefusal(password: string): PolicyRefusal | null {
  if (password.length < MINIMUM_PASSWORD_LENGTH) return 'WEAK_PASSWORD';
  if (password.length > MAXIMUM_PASSWORD_LENGTH) return 'WEAK_PASSWORD';
  if (password.trim() === '') return 'WEAK_PASSWORD';
  if (new Set(password).size < MINIMUM_DISTINCT_CHARACTERS) return 'WEAK_PASSWORD';
  return null;
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString('base64url')}`;
}

async function inTransaction<T>(client: Client, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

interface LiveEnrollmentRow {
  enrollment_id: string;
  login_name: string;
  code_hash: string;
  expires_at: Date;
}

/**
 * Lock the workspace, then the live enrollment.
 *
 * Locking the workspace row first gives concurrent callers a lock target that exists even
 * when the workspace has no enrollment yet, so two issuers cannot both find an empty slot
 * and race the partial unique index into an incidental 23505.
 */
async function lockWorkspace(client: Client, workspaceId: string): Promise<boolean> {
  const locked = await client.query(
    'SELECT workspace_id FROM workspaces WHERE workspace_id = $1 FOR UPDATE',
    [workspaceId],
  );
  return locked.rowCount === 1;
}

async function lockLiveEnrollment(
  client: Client,
  workspaceId: string,
): Promise<LiveEnrollmentRow | undefined> {
  const live = await client.query<LiveEnrollmentRow>(
    `SELECT enrollment_id, login_name, code_hash, expires_at
       FROM owner_enrollments
      WHERE workspace_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL
        FOR UPDATE`,
    [workspaceId],
  );
  return live.rows[0];
}

async function invalidate(
  client: Client,
  enrollmentId: string,
  reason: 'expired' | 'rotated',
  at: Date,
): Promise<void> {
  await client.query(
    `UPDATE owner_enrollments
        SET invalidated_at = $2, invalidated_reason = $3
      WHERE enrollment_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [enrollmentId, at, reason],
  );
}

/**
 * Audit detail passes through the same closed schema the HTTP layer uses, so the CLI cannot
 * become the one writer that puts an unfiltered string into the column.
 */
async function audit(
  client: Client,
  input: {
    workspaceId: string;
    /** Always an identifier this module generated: an enrollment id or a new user id. */
    actorId: string;
    action: 'owner.enrollment.issue' | 'owner.enrollment.redeem';
    outcome: 'allowed' | 'denied';
    detail: AuditDetail;
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (workspace_id, occurred_at, actor_kind, actor_id, action, outcome, detail)
     VALUES ($1, $2, 'operator-cli', $3, $4, $5, $6::jsonb)`,
    [
      input.workspaceId,
      input.at,
      input.actorId,
      input.action,
      input.outcome,
      JSON.stringify(sanitizeAuditDetail(input.detail).detail),
    ],
  );
}

async function ownerExists(client: Client, workspaceId: string): Promise<boolean> {
  const owner = await client.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND role = 'owner'`,
    [workspaceId],
  );
  return owner.rowCount === 1;
}

export type IssueOutcome =
  | {
      readonly ok: true;
      readonly enrollmentId: string;
      /** Printed once to the operator's terminal. Never stored, never logged, never returned again. */
      readonly code: string;
      readonly expiresAt: Date;
      /** The row this issue withdrew, and why. Null when the slot was already empty. */
      readonly superseded: {
        readonly enrollmentId: string;
        readonly reason: 'expired' | 'rotated';
      } | null;
    }
  | {
      readonly ok: false;
      readonly reason:
        | PolicyRefusal
        | 'UNKNOWN_WORKSPACE'
        | 'OWNER_ALREADY_ENROLLED'
        | 'LIVE_ENROLLMENT_OUTSTANDING';
    };

/**
 * Issue a single-use enrollment code.
 *
 * A live code is never silently replaced: reissuing while one is outstanding requires
 * `rotate`, because the operator may have already handed that code to the owner and an
 * accidental second `issue` must not quietly revoke it. A *lapsed* code needs no such
 * ceremony — it can no longer be redeemed — so it is withdrawn as 'expired' and the slot
 * reopens without anyone deleting a record.
 */
export async function issueEnrollment(
  client: Client,
  input: {
    readonly workspaceId: string;
    readonly loginName: string;
    readonly rotate?: boolean;
    readonly now?: Date;
  },
): Promise<IssueOutcome> {
  const refusal = loginNameRefusal(input.loginName);
  if (refusal !== null) return { ok: false, reason: refusal };

  const now = input.now ?? new Date();

  return inTransaction(client, async (): Promise<IssueOutcome> => {
    if (!(await lockWorkspace(client, input.workspaceId))) {
      return { ok: false, reason: 'UNKNOWN_WORKSPACE' };
    }
    // Enrollment is bootstrap, not user administration. Once an owner exists, adding people
    // is a membership decision made by that owner, not a second code minted at the database.
    if (await ownerExists(client, input.workspaceId)) {
      return { ok: false, reason: 'OWNER_ALREADY_ENROLLED' };
    }

    let superseded: { enrollmentId: string; reason: 'expired' | 'rotated' } | null = null;
    const live = await lockLiveEnrollment(client, input.workspaceId);
    if (live !== undefined) {
      const lapsed = live.expires_at.getTime() <= now.getTime();
      if (!lapsed && input.rotate !== true) {
        return { ok: false, reason: 'LIVE_ENROLLMENT_OUTSTANDING' };
      }
      const reason = lapsed ? 'expired' : 'rotated';
      await invalidate(client, live.enrollment_id, reason, now);
      superseded = { enrollmentId: live.enrollment_id, reason };
    }

    const code = randomBytes(24).toString('base64url');
    const enrollmentId = newId('enr');
    const expiresAt = new Date(now.getTime() + CODE_LIFETIME_MS);
    await client.query(
      `INSERT INTO owner_enrollments (enrollment_id, workspace_id, login_name, code_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        enrollmentId,
        input.workspaceId,
        input.loginName,
        await hashHumanSecret(code),
        expiresAt,
        now,
      ],
    );
    await audit(client, {
      workspaceId: input.workspaceId,
      // The enrollment this act created. Generated here, so nothing a caller supplied reaches
      // the column; there is no parameter through which it could.
      actorId: enrollmentId,
      action: 'owner.enrollment.issue',
      outcome: 'allowed',
      // The login name is caller-supplied text on this path, and an operator who types a
      // secret into it would otherwise put it in the durable trail. The enrollment id is
      // server-generated and identifies the act; the login name is recoverable from the
      // enrollment row itself, which is not an audit record.
      detail: {
        enrollmentId,
        supersededEnrollmentId: superseded?.enrollmentId ?? null,
        supersededReason: superseded?.reason ?? null,
      },
      at: now,
    });

    return { ok: true, enrollmentId, code, expiresAt, superseded };
  });
}

export type RedeemOutcome =
  | { readonly ok: true; readonly userId: string; readonly loginName: string }
  | {
      readonly ok: false;
      readonly reason:
        | PolicyRefusal
        | 'UNKNOWN_WORKSPACE'
        | 'OWNER_ALREADY_ENROLLED'
        | 'NO_LIVE_ENROLLMENT'
        | 'ALREADY_CONSUMED'
        | 'INVALIDATED'
        | 'EXPIRED'
        | 'WRONG_CODE'
        /**
         * `users.login_name` is unique across every workspace, so a name already enrolled
         * elsewhere collides. Reported as a decision rather than surfacing a raw 23505 with
         * whatever the driver puts in its message.
         */
        | 'LOGIN_NAME_TAKEN';
    };

/**
 * Why a workspace has no live enrollment.
 *
 * The refusal describes the workspace's enrollment slot, not the code the caller presented —
 * it is reached without comparing the code at all, so it reveals nothing about it.
 */
async function noLiveEnrollmentReason(
  client: Client,
  workspaceId: string,
): Promise<'NO_LIVE_ENROLLMENT' | 'ALREADY_CONSUMED' | 'INVALIDATED'> {
  const latest = await client.query<{ consumed_at: Date | null; invalidated_at: Date | null }>(
    `SELECT consumed_at, invalidated_at FROM owner_enrollments
      WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  const row = latest.rows[0];
  if (row === undefined) return 'NO_LIVE_ENROLLMENT';
  if (row.consumed_at !== null) return 'ALREADY_CONSUMED';
  if (row.invalidated_at !== null) return 'INVALIDATED';
  return 'NO_LIVE_ENROLLMENT';
}

/**
 * Redeem a code, creating the owner and their membership in one transaction.
 *
 * The live row is read *inside* the transaction and locked, so a second concurrent redeemer
 * blocks until the first commits and then re-qualifies against the consumed row — it finds
 * no live enrollment and refuses. Exactly one caller creates exactly one user, one owner
 * membership and one allowed audit event; the loser gets a decision, not a unique-violation
 * it happened to lose.
 *
 * All-or-nothing: a user without a membership is an account no authorization decision can
 * reach, and a membership without a user is a dangling grant.
 */
export async function redeemEnrollment(
  client: Client,
  input: {
    readonly workspaceId: string;
    readonly code: string;
    readonly password: string;
    readonly now?: Date;
  },
): Promise<RedeemOutcome> {
  // Before any database work, and before Argon2id is asked to digest it.
  const refusal = passwordRefusal(input.password);
  if (refusal !== null) return { ok: false, reason: refusal };

  const now = input.now ?? new Date();

  return inTransaction(client, async (): Promise<RedeemOutcome> => {
    if (!(await lockWorkspace(client, input.workspaceId))) {
      return { ok: false, reason: 'UNKNOWN_WORKSPACE' };
    }
    if (await ownerExists(client, input.workspaceId)) {
      return { ok: false, reason: 'OWNER_ALREADY_ENROLLED' };
    }

    const live = await lockLiveEnrollment(client, input.workspaceId);
    if (live === undefined) {
      return { ok: false, reason: await noLiveEnrollmentReason(client, input.workspaceId) };
    }

    if (live.expires_at.getTime() <= now.getTime()) {
      // Record the lapse on discovery so the next issue finds an empty slot.
      await invalidate(client, live.enrollment_id, 'expired', now);
      await audit(client, {
        workspaceId: input.workspaceId,
        actorId: live.enrollment_id,
        action: 'owner.enrollment.redeem',
        outcome: 'denied',
        detail: { enrollmentId: live.enrollment_id, refusal: 'EXPIRED' },
        at: now,
      });
      return { ok: false, reason: 'EXPIRED' };
    }

    if (!(await verifyHumanSecret(live.code_hash, input.code))) {
      // The attempt is durable evidence, so it commits. The code is not in it.
      await audit(client, {
        workspaceId: input.workspaceId,
        actorId: live.enrollment_id,
        action: 'owner.enrollment.redeem',
        outcome: 'denied',
        detail: { enrollmentId: live.enrollment_id, refusal: 'WRONG_CODE' },
        at: now,
      });
      return { ok: false, reason: 'WRONG_CODE' };
    }

    // Checked under the workspace lock this transaction already holds, and the unique index
    // is still the arbiter: a concurrent redeemer in another workspace makes the insert fail,
    // and that is caught below rather than escaping as a database error.
    const taken = await client.query(`SELECT 1 FROM users WHERE login_name = $1`, [
      live.login_name,
    ]);
    if (taken.rowCount === 1) return { ok: false, reason: 'LOGIN_NAME_TAKEN' };

    const userId = newId('usr');
    // The pre-check above settles the sequential case. Under concurrency both redeemers pass
    // it and the unique index is the arbiter, so the loser's violation becomes the same
    // decision here rather than escaping as a raw database error. A savepoint, so the refusal
    // is a value this function returns and not an aborted transaction the caller inherits.
    await client.query('SAVEPOINT before_user');
    try {
      // consumed_by is an immediate foreign key, so the user row exists before the consume runs.
      await client.query(
        `INSERT INTO users (user_id, login_name, password_hash) VALUES ($1, $2, $3)`,
        [userId, live.login_name, await hashHumanSecret(input.password)],
      );
      const consumed = await client.query(
        `UPDATE owner_enrollments
            SET consumed_at = $2, consumed_by = $3
          WHERE enrollment_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [live.enrollment_id, now, userId],
      );
      // Unreachable while the row lock above holds. Asserted anyway: a future change that drops
      // the lock must fail loudly and roll back, not mint a second owner from one code.
      if (consumed.rowCount !== 1) {
        throw new Error('enrollment consume affected an unexpected number of rows');
      }
      await client.query(
        `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [input.workspaceId, userId],
      );
      await audit(client, {
        workspaceId: input.workspaceId,
        actorId: userId,
        action: 'owner.enrollment.redeem',
        outcome: 'allowed',
        detail: { enrollmentId: live.enrollment_id, userId },
        at: now,
      });
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'users_login_name_key') {
        await client.query('ROLLBACK TO SAVEPOINT before_user');
        return { ok: false, reason: 'LOGIN_NAME_TAKEN' };
      }
      throw error;
    }

    return { ok: true, userId, loginName: live.login_name };
  });
}
