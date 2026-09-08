import type { Pool, PoolClient } from 'pg';
import type { ActorRole, Capability, Principal } from '@capitaldesk/domain';
import { principal } from '@capitaldesk/domain';
import { digestOfHighEntropySecret, hashHumanSecret, verifyHumanSecret } from './secrets.js';
import { type AuditDetail, sanitizeAuditDetail } from './audit-detail.js';

/**
 * Identity reads and writes.
 *
 * Two rules hold throughout, and both exist because a valid identifier from another tenant is
 * the realistic attack, not a malformed one:
 *
 *  1. Every query filters by the full scope of the thing it returns. There is no lookup by
 *     bare id anywhere in this file, so a caller cannot accidentally write one.
 *  2. Nothing here reads request input. A `Principal` is built only from columns just read
 *     from the database, which is where the module's acceptance gate is actually enforced —
 *     the pure factory validates shape, it cannot establish provenance.
 */

export type Executor = Pool | PoolClient;

/**
 * A pooled client carries `release`; a pool does not. `connect` is on both, so it cannot tell
 * them apart — an earlier draft that discriminated on it would have called `pool.connect()`
 * on a client already inside a transaction.
 */
function isPoolClient(db: Executor): db is PoolClient {
  return typeof (db as PoolClient).release === 'function';
}

export interface SessionLifetimes {
  /** Fixed at creation; activity never extends it. */
  readonly absoluteMs: number;
  /** Recomputed from the last authenticated request. */
  readonly idleMs: number;
}

/** 12 hours absolute, 30 minutes idle. */
export const DEFAULT_SESSION_LIFETIMES: SessionLifetimes = {
  absoluteMs: 12 * 60 * 60 * 1000,
  idleMs: 30 * 60 * 1000,
};

export type IssueCredentialOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'UNKNOWN_STRATEGY' | 'UNKNOWN_CREDENTIAL' }
  /**
   * A first issue while a key is already live. The id is returned so an owner whose issuance
   * response was lost can find the credential they cannot otherwise name, and rotate it.
   */
  | {
      readonly ok: false;
      readonly reason: 'ACTIVE_CREDENTIAL_EXISTS';
      readonly activeCredentialId: string;
    };

/** What the owner may see about a credential. Never the digest, never a secret. */
export interface AgentCredentialMetadata {
  readonly credentialId: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly revealedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly rotatedFrom: string | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

export interface OwnerSessionRow {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: ActorRole;
}

/**
 * Who an audit record is attributed to.
 *
 * Deliberately not a string. Every variant carries values the server established — a principal
 * built from stored columns, a member row this repository just read, or no identity at all —
 * so there is no parameter a route could pass a path segment through.
 */
export type AuditActor =
  | { readonly kind: 'principal'; readonly principal: Principal }
  | { readonly kind: 'member'; readonly workspaceId: string; readonly userId: string }
  | { readonly kind: 'unauthenticated'; readonly workspaceId: string };

/** The lifecycle acts this module records, beyond the capability names used for denials. */
export type LifecycleAuditAction =
  | 'session.login'
  | 'session.logout'
  | 'credential.issue'
  | 'credential.rotate'
  | 'credential.revoke';

/** Closed: a denial records the capability it refused, and nothing else is writable. */
export type AuditAction = Capability | LifecycleAuditAction;

interface AuditColumns {
  readonly workspaceId: string;
  readonly actorKind: 'owner-session' | 'agent-credential' | 'operator-cli' | 'system';
  readonly actorId: string;
  readonly poolId: string | null;
  readonly strategyId: string | null;
}

function auditColumnsFor(actor: AuditActor): AuditColumns {
  switch (actor.kind) {
    case 'principal':
      return {
        workspaceId: actor.principal.scope.workspaceId,
        actorKind: actor.principal.kind,
        actorId: actor.principal.subjectId,
        // The principal's own bound scope. An agent's pool and strategy are the ones its
        // credential row names; an owner session has neither.
        poolId: actor.principal.scope.poolId,
        strategyId: actor.principal.scope.strategyId,
      };
    case 'member':
      return {
        workspaceId: actor.workspaceId,
        actorKind: 'owner-session',
        actorId: actor.userId,
        poolId: null,
        strategyId: null,
      };
    case 'unauthenticated':
      return {
        workspaceId: actor.workspaceId,
        actorKind: 'system',
        actorId: 'unauthenticated',
        poolId: null,
        strategyId: null,
      };
  }
}

export class IdentityRepository {
  constructor(
    private readonly db: Executor,
    private readonly lifetimes: SessionLifetimes = DEFAULT_SESSION_LIFETIMES,
  ) {}

  /**
   * Run related writes on one checked-out connection, inside one transaction.
   *
   * Without this, a repository built on a `Pool` runs each statement in its own autocommit
   * transaction and possibly on a different connection. For credential rotation that is not a
   * tidiness problem: the revoke of the old key, the insert of the new one and the audit
   * record would be three independent outcomes, so a failure between them could revoke an
   * owner's working key while creating nothing at all.
   *
   * What this cannot cover is delivery. Whether the caller's one-time response arrives is not
   * a database property, so a committed credential whose secret never reached anyone remains
   * possible; rotation is the recovery.
   */
  async transaction<T>(work: (tx: IdentityRepository) => Promise<T>): Promise<T> {
    if (isPoolClient(this.db)) {
      // Already inside one. Nesting would issue a second BEGIN, whose COMMIT would end the
      // outer transaction early and silently.
      throw new Error('IdentityRepository.transaction cannot nest');
    }
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new IdentityRepository(client, this.lifetimes));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // --- owner authentication ------------------------------------------------------------

  /**
   * Look up a member by login name, scoped to the workspace.
   *
   * Returns the password digest so the caller can verify it. The caller must run the
   * verification even when this returns null, against a dummy digest, so a missing user and a
   * wrong password take the same time and the response cannot be used to enumerate accounts.
   */
  async findMemberByLogin(
    workspaceId: string,
    loginName: string,
  ): Promise<{ userId: string; role: ActorRole; passwordHash: string | null } | null> {
    const result = await this.db.query<{
      user_id: string;
      role: ActorRole;
      password_hash: string | null;
    }>(
      `SELECT u.user_id, m.role, u.password_hash
         FROM memberships m
         JOIN users u ON u.user_id = m.user_id
        WHERE m.workspace_id = $1
          AND u.login_name = $2
          AND u.disabled_at IS NULL`,
      [workspaceId, loginName],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { userId: row.user_id, role: row.role, passwordHash: row.password_hash };
  }

  /**
   * Create a session and record that it was created, together.
   *
   * A session is authority. Creating one whose audit record failed to write leaves authority
   * in the system that the trail does not account for, which is the outcome an audit trail
   * exists to make impossible — so the two are one transaction and a failed audit rolls the
   * session back rather than leaving it live and unrecorded.
   */
  async beginOwnerSession(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly now: Date;
  }): Promise<void> {
    const absolute = new Date(input.now.getTime() + this.lifetimes.absoluteMs);
    const idle = new Date(input.now.getTime() + this.lifetimes.idleMs);
    await this.transaction(async (tx) => {
      await tx.db.query(
        `INSERT INTO owner_sessions
           (session_id_hash, workspace_id, user_id, created_at, last_seen_at,
            absolute_expires_at, idle_expires_at)
         VALUES ($1, $2, $3, $4, $4, $5, $6)`,
        [
          digestOfHighEntropySecret(input.sessionId),
          input.workspaceId,
          input.userId,
          input.now,
          absolute,
          idle,
        ],
      );
      await tx.recordAudit({
        actor: { kind: 'member', workspaceId: input.workspaceId, userId: input.userId },
        action: 'session.login',
        outcome: 'allowed',
      });
    });
  }

  /**
   * Resolve a session identifier to a principal, and slide the idle window.
   *
   * Expiry, revocation, membership and account status are evaluated in the same statement
   * that reads the row, so a request cannot observe a session between the read and the check.
   * The idle window is extended only up to the absolute expiry, so activity can never outlive
   * the fixed lifetime.
   *
   * The join to `users` is part of the check, not decoration: without `disabled_at IS NULL`
   * here, disabling an account would leave every session it already holds working until it
   * expired, and correctness would depend on a separate revoke-all call having run and having
   * missed nothing. Disabling fails closed instead.
   */
  async resolveSession(sessionId: string, now: Date): Promise<Principal | null> {
    const result = await this.db.query<{
      workspace_id: string;
      user_id: string;
      role: ActorRole;
    }>(
      `UPDATE owner_sessions s
          SET last_seen_at = $2,
              idle_expires_at = LEAST($3::timestamptz, s.absolute_expires_at)
         FROM memberships m, users u
        WHERE s.session_id_hash = $1
          AND m.workspace_id = s.workspace_id
          AND m.user_id = s.user_id
          AND u.user_id = s.user_id
          AND u.disabled_at IS NULL
          AND s.revoked_at IS NULL
          AND s.absolute_expires_at > $2
          AND s.idle_expires_at > $2
      RETURNING s.workspace_id, s.user_id, m.role`,
      [digestOfHighEntropySecret(sessionId), now, new Date(now.getTime() + this.lifetimes.idleMs)],
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    return principal({
      kind: 'owner-session',
      role: row.role,
      subjectId: row.user_id,
      scope: { workspaceId: row.workspace_id, poolId: null, strategyId: null },
    });
  }

  /**
   * Revoke a session and record that it ended, together.
   *
   * Same reasoning in the other direction: an unaudited revocation is a gap in the record of
   * when authority ended. `revoked_at` is set; the row is retained.
   *
   * Returns whether a live session was found, so a caller can tell a real logout from a
   * request carrying a session that was already over.
   */
  async endOwnerSession(input: {
    readonly sessionId: string;
    readonly reason: string;
    /** The principal the server resolved for this request, not anything from the path. */
    readonly actor: Principal;
    readonly now: Date;
  }): Promise<boolean> {
    return this.transaction(async (tx) => {
      const result = await tx.db.query(
        `UPDATE owner_sessions
            SET revoked_at = $3, revoked_reason = $4
          WHERE session_id_hash = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
        [
          digestOfHighEntropySecret(input.sessionId),
          input.actor.scope.workspaceId,
          input.now,
          input.reason,
        ],
      );
      const revoked = (result.rowCount ?? 0) > 0;
      await tx.recordAudit({
        actor: { kind: 'principal', principal: input.actor },
        action: 'session.logout',
        outcome: revoked ? 'allowed' : 'failed',
      });
      return revoked;
    });
  }

  /** Revoke every session for a member — used when a role changes or an account is disabled. */
  async revokeAllSessionsFor(
    workspaceId: string,
    userId: string,
    reason: string,
    now: Date,
  ): Promise<number> {
    const result = await this.db.query(
      `UPDATE owner_sessions
          SET revoked_at = $3, revoked_reason = $4
        WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [workspaceId, userId, now, reason],
    );
    return result.rowCount ?? 0;
  }

  // --- agent credentials ----------------------------------------------------------------

  /**
   * Resolve an agent credential to a principal.
   *
   * The scope comes from the credential's own row — the workspace, pool and strategy it was
   * issued for — never from the request. This is the acceptance gate: no agent-controlled
   * field selects its owner, permission level or execution account.
   *
   * Verification is slow by design, and revocation can commit while it runs. An earlier draft
   * read the active row, spent tens of milliseconds in Argon2id, then touched `last_used_at`
   * by credential id alone and returned a principal — so a key revoked in that window still
   * completed authentication. The fix is to make the last write the decision: the guarded
   * UPDATE below re-checks revocation, the strategy tuple and archival, and the principal is
   * built from *its* RETURNING clause. If a revocation committed meanwhile, it matches no row
   * and authentication fails.
   *
   * Deliberately no `FOR UPDATE` over the verification: locking would serialise every request
   * for a credential behind one Argon2id computation, and it would let authentication beat a
   * revocation that arrived during it. Revocation should win that tie.
   */
  async resolveAgentCredential(
    credentialId: string,
    secret: string,
    now: Date,
  ): Promise<Principal | null> {
    const found = await this.db.query<{ secret_hash: string }>(
      `SELECT c.secret_hash
         FROM agent_credentials c
         JOIN strategies s
           ON s.workspace_id = c.workspace_id
          AND s.pool_id = c.pool_id
          AND s.strategy_id = c.strategy_id
        WHERE c.credential_id = $1
          AND c.revoked_at IS NULL
          AND s.archived_at IS NULL`,
      [credentialId],
    );
    const row = found.rows[0];
    if (row === undefined) return null;

    if (!(await verifyHumanSecret(row.secret_hash, secret))) return null;

    const confirmed = await this.db.query<{
      workspace_id: string;
      pool_id: string;
      strategy_id: string;
    }>(
      `UPDATE agent_credentials c
          SET last_used_at = $2
         FROM strategies s
        WHERE c.credential_id = $1
          AND c.revoked_at IS NULL
          AND s.workspace_id = c.workspace_id
          AND s.pool_id = c.pool_id
          AND s.strategy_id = c.strategy_id
          AND s.archived_at IS NULL
      RETURNING c.workspace_id, c.pool_id, c.strategy_id`,
      [credentialId, now],
    );
    const active = confirmed.rows[0];
    if (active === undefined) return null;

    return principal({
      kind: 'agent-credential',
      role: 'agent',
      subjectId: credentialId,
      scope: {
        workspaceId: active.workspace_id,
        poolId: active.pool_id,
        strategyId: active.strategy_id,
      },
    });
  }

  /**
   * Issue a credential for a strategy, or rotate an existing one, atomically with its audit
   * record.
   *
   * Everything below runs on one checked-out client inside one transaction, so the three
   * outcomes that must agree — the old key revoked, the new key live, the act recorded —
   * either all happen or none do.
   *
   * That guarantee stops at the database. Whether the caller's one-time response reaches its
   * recipient is not something a COMMIT can establish, so a committed credential whose secret
   * was never received is a real outcome; rotation is the recovery, and no read path exists.
   *
   * Rotation names the credential it replaces through the complete
   * (workspace, pool, strategy, credential) tuple. A predicate missing `pool_id` would let a
   * credential id from another pool in the same workspace select the row to revoke.
   */
  async issueAgentCredential(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly credentialId: string;
    readonly secret: string;
    readonly label: string;
    /** Set for a rotation; null for a first issue. */
    readonly rotatedFrom: string | null;
    /** The owner principal the server resolved. Its subject id is what the trail records. */
    readonly actor: Principal;
    readonly now: Date;
  }): Promise<IssueCredentialOutcome> {
    // Hash before opening the transaction: Argon2id is deliberately slow, and holding a
    // connection and its locks across it would serialise unrelated work behind it.
    const secretHash = await hashHumanSecret(input.secret);

    return this.transaction(async (tx): Promise<IssueCredentialOutcome> => {
      const strategy = await tx.db.query(
        `SELECT 1 FROM strategies
          WHERE workspace_id = $1 AND pool_id = $2 AND strategy_id = $3
            AND archived_at IS NULL
            FOR UPDATE`,
        [input.workspaceId, input.poolId, input.strategyId],
      );
      if (strategy.rowCount !== 1) {
        // An authorized caller naming a strategy that does not exist, or was archived, is a
        // security-relevant refusal: it is what probing for another pool's identifiers looks
        // like. Recorded with no scope, because the tuple was never confirmed.
        await tx.recordAudit({
          actor: { kind: 'principal', principal: input.actor },
          action: input.rotatedFrom === null ? 'credential.issue' : 'credential.rotate',
          outcome: 'failed',
          detail: { refusal: 'UNKNOWN_STRATEGY' },
        });
        return { ok: false, reason: 'UNKNOWN_STRATEGY' };
      }

      if (input.rotatedFrom === null) {
        // A first issue against a strategy that already has a live key is a decision, not a
        // unique-violation to be caught. The realistic way here is a lost issuance response:
        // the owner never saw the credential id, so they cannot rotate it, and the partial
        // unique index answered their retry with a 500. Name the live key instead.
        const active = await tx.db.query<{ credential_id: string }>(
          `SELECT credential_id FROM agent_credentials
            WHERE workspace_id = $1 AND pool_id = $2 AND strategy_id = $3 AND revoked_at IS NULL
              FOR UPDATE`,
          [input.workspaceId, input.poolId, input.strategyId],
        );
        const live = active.rows[0];
        if (live !== undefined) {
          await tx.recordConfirmedScopeAudit({
            actor: { kind: 'principal', principal: input.actor },
            action: 'credential.issue',
            outcome: 'failed',
            confirmed: { poolId: input.poolId, strategyId: input.strategyId },
            detail: { refusal: 'ACTIVE_CREDENTIAL_EXISTS', credentialId: live.credential_id },
          });
          return {
            ok: false,
            reason: 'ACTIVE_CREDENTIAL_EXISTS',
            activeCredentialId: live.credential_id,
          };
        }
      }

      if (input.rotatedFrom !== null) {
        const revoked = await tx.db.query(
          `UPDATE agent_credentials
              SET revoked_at = $5, revoked_reason = 'rotated'
            WHERE credential_id = $4
              AND workspace_id = $1 AND pool_id = $2 AND strategy_id = $3
              AND revoked_at IS NULL`,
          [input.workspaceId, input.poolId, input.strategyId, input.rotatedFrom, input.now],
        );
        if (revoked.rowCount !== 1) {
          await tx.recordAudit({
            actor: { kind: 'principal', principal: input.actor },
            action: 'credential.rotate',
            outcome: 'failed',
            detail: { refusal: 'UNKNOWN_CREDENTIAL' },
          });
          return { ok: false, reason: 'UNKNOWN_CREDENTIAL' };
        }
      }

      // revealed_at is written here, inside the transaction, before any response exists. It
      // marks the row as having been issued on the one-time reveal path so a second reveal
      // can be refused; it says nothing about whether the response was built, sent or read.
      await tx.db.query(
        `INSERT INTO agent_credentials
           (credential_id, workspace_id, pool_id, strategy_id, secret_hash, label, rotated_from,
            created_at, revealed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          input.credentialId,
          input.workspaceId,
          input.poolId,
          input.strategyId,
          secretHash,
          input.label,
          input.rotatedFrom,
          input.now,
        ],
      );

      // The strategy tuple was locked and confirmed at the top of this transaction, so it is
      // a database fact by the time it reaches a column.
      await tx.recordConfirmedScopeAudit({
        actor: { kind: 'principal', principal: input.actor },
        action: input.rotatedFrom === null ? 'credential.issue' : 'credential.rotate',
        outcome: 'allowed',
        confirmed: { poolId: input.poolId, strategyId: input.strategyId },
        detail:
          input.rotatedFrom === null
            ? { credentialId: input.credentialId }
            : { credentialId: input.credentialId, rotatedFrom: input.rotatedFrom },
      });

      return { ok: true };
    });
  }

  /**
   * The credentials of one strategy, as the owner may see them.
   *
   * Metadata only. This is the recovery path for a lost issuance response: the owner can find
   * the live credential's id here and rotate it. What cannot be recovered is the secret, and
   * no column here could carry it.
   */
  async listAgentCredentials(scope: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
  }): Promise<readonly AgentCredentialMetadata[]> {
    const result = await this.db.query<{
      credential_id: string;
      label: string;
      created_at: Date;
      revealed_at: Date | null;
      last_used_at: Date | null;
      rotated_from: string | null;
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>(
      `SELECT credential_id, label, created_at, revealed_at, last_used_at, rotated_from,
              revoked_at, revoked_reason
         FROM agent_credentials
        WHERE workspace_id = $1 AND pool_id = $2 AND strategy_id = $3
        ORDER BY created_at DESC, credential_id`,
      [scope.workspaceId, scope.poolId, scope.strategyId],
    );
    return result.rows.map((row) => ({
      credentialId: row.credential_id,
      label: row.label,
      createdAt: row.created_at,
      revealedAt: row.revealed_at,
      lastUsedAt: row.last_used_at,
      rotatedFrom: row.rotated_from,
      revokedAt: row.revoked_at,
      revokedReason: row.revoked_reason,
    }));
  }

  /**
   * Revoke a credential and record the act together.
   *
   * Revocation sets `revoked_at`; nothing is deleted. The row remains as the evidence that a
   * key existed and when its authority ended.
   */
  async revokeAgentCredential(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly credentialId: string;
    readonly reason: string;
    readonly actor: Principal;
    readonly now: Date;
  }): Promise<boolean> {
    return this.transaction(async (tx) => {
      const result = await tx.db.query(
        `UPDATE agent_credentials
            SET revoked_at = $5, revoked_reason = $6
          WHERE credential_id = $4
            AND workspace_id = $1 AND pool_id = $2 AND strategy_id = $3
            AND revoked_at IS NULL`,
        [
          input.workspaceId,
          input.poolId,
          input.strategyId,
          input.credentialId,
          input.now,
          input.reason,
        ],
      );
      const revoked = (result.rowCount ?? 0) > 0;
      if (revoked) {
        // The update matched, so this tuple names a real credential in a real scope.
        await tx.recordConfirmedScopeAudit({
          actor: { kind: 'principal', principal: input.actor },
          action: 'credential.revoke',
          outcome: 'allowed',
          confirmed: { poolId: input.poolId, strategyId: input.strategyId },
          detail: { credentialId: input.credentialId },
        });
      } else {
        // Nothing matched, so the tuple is unverified caller input and does not reach a
        // column. The trail records that a revocation was refused, not the strings it named.
        await tx.recordAudit({
          actor: { kind: 'principal', principal: input.actor },
          action: 'credential.revoke',
          outcome: 'failed',
          detail: { refusal: 'NO_MATCHING_CREDENTIAL' },
        });
      }
      return revoked;
    });
  }

  // --- audit -----------------------------------------------------------------------------

  /**
   * Append an audit record.
   *
   * Every field that reaches a column here is server-derived. The actor is a value this
   * repository or the authenticator produced, and the scope columns come from that actor's own
   * bound scope — never from the request path.
   *
   * That is the boundary, and it is provenance rather than filtering. `detail` still passes
   * through the closed schema in `audit-detail.ts`, but a schema cannot be the whole answer:
   * `pool_id` and `strategy_id` accepted whatever the route path contained, and no regex can
   * tell a pool id from a token shaped like one. The API simply has no parameter through which
   * a path segment can arrive.
   *
   * The logger's redaction never sees this write — it goes straight to PostgreSQL — so the
   * boundary has to be here.
   */
  /**
   * Record an act on a strategy whose scope tuple this transaction has just confirmed.
   *
   * Private, and used only on paths where the preceding statement matched a real row — the
   * locked strategy in `issueAgentCredential`, the affected credential in
   * `revokeAgentCredential`. That confirmation is what makes these values evidence rather than
   * caller input; a path that has not confirmed the tuple records a null scope instead.
   */
  private async recordConfirmedScopeAudit(event: {
    readonly actor: AuditActor;
    readonly action: AuditAction;
    readonly outcome: 'allowed' | 'denied' | 'failed';
    readonly confirmed: { readonly poolId: string; readonly strategyId: string };
    readonly detail?: AuditDetail;
  }): Promise<void> {
    const row = auditColumnsFor(event.actor);
    await this.db.query(
      `INSERT INTO audit_events
         (workspace_id, actor_kind, actor_id, action, outcome, pool_id, strategy_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        row.workspaceId,
        row.actorKind,
        row.actorId,
        event.action,
        event.outcome,
        event.confirmed.poolId,
        event.confirmed.strategyId,
        JSON.stringify(sanitizeAuditDetail(event.detail ?? {}).detail),
      ],
    );
  }

  async recordAudit(event: {
    readonly actor: AuditActor;
    readonly action: AuditAction;
    readonly outcome: 'allowed' | 'denied' | 'failed';
    readonly detail?: AuditDetail;
  }): Promise<void> {
    const row = auditColumnsFor(event.actor);
    const detail = JSON.stringify(sanitizeAuditDetail(event.detail ?? {}).detail);

    if (event.actor.kind === 'unauthenticated') {
      // The workspace identifier is the one field here that a caller chose, and it is only
      // ever a workspace that exists: this insert is a no-op otherwise.
      //
      // The ordinary insert has a foreign key to `workspaces`, which is right everywhere the
      // workspace has already been established. On the login route it is not — the identifier
      // is whatever the caller put in the path. Writing it there raised a foreign-key
      // violation and the route answered 500, while a wrong password in a real workspace
      // answered 401, so the status code alone told an unauthenticated caller which
      // workspaces exist.
      await this.db.query(
        `INSERT INTO audit_events (workspace_id, actor_kind, actor_id, action, outcome, detail)
         SELECT $1, $2, $3, $4, $5, $6::jsonb
          WHERE EXISTS (SELECT 1 FROM workspaces WHERE workspace_id = $1)`,
        [row.workspaceId, row.actorKind, row.actorId, event.action, event.outcome, detail],
      );
      return;
    }

    await this.db.query(
      `INSERT INTO audit_events
         (workspace_id, actor_kind, actor_id, action, outcome, pool_id, strategy_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        row.workspaceId,
        row.actorKind,
        row.actorId,
        event.action,
        event.outcome,
        row.poolId,
        row.strategyId,
        detail,
      ],
    );
  }
}
