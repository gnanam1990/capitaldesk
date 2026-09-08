import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateSecret, formatAgentToken } from './secrets.js';
import { verifyOwnerPassword } from './authenticate.js';
import { sessionCookieName, sessionCookieOptions } from './plugin.js';
import type { IdentityRepository } from './repository.js';

/**
 * The routes module 03 owns: owner session lifecycle, principal introspection and agent
 * credential lifecycle. Nothing else — economic routes arrive with the modules that implement
 * the behaviour behind them.
 */

export interface AuthRouteOptions {
  readonly repository: IdentityRepository;
  readonly environment: string;
  readonly secureCookies: boolean;
  readonly now?: () => Date;
}

interface LoginBody {
  readonly loginName?: unknown;
  readonly password?: unknown;
}

const LOGIN_SCHEMA = {
  type: 'object',
  required: ['loginName', 'password'],
  // No additional properties: a body cannot carry a role, a workspace or a user id alongside
  // the credentials and hope something reads it.
  additionalProperties: false,
  properties: {
    loginName: { type: 'string', minLength: 3, maxLength: 64 },
    password: { type: 'string', minLength: 12, maxLength: 512 },
  },
} as const;

const CREDENTIAL_LABEL_SCHEMA = {
  type: 'object',
  required: ['label'],
  additionalProperties: false,
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const now = options.now ?? ((): Date => new Date());
  // Bound once. Passing a decorated method as a bare value detaches it from its instance,
  // which is a real hazard for `csrfProtection` — it reads the plugin's own configuration.
  const csrfProtection = app.csrfProtection.bind(app);
  const cookieName = sessionCookieName(options.secureCookies);
  const { repository } = options;

  /**
   * Owner login.
   *
   * Rate limited, because this is the one route that accepts an unauthenticated guess. The
   * response is identical for an unknown login and a wrong password, and both paths perform
   * one Argon2id verification so they cost the same.
   */
  app.post<{ Params: { workspaceId: string }; Body: LoginBody }>(
    '/v1/workspaces/:workspaceId/sessions',
    {
      schema: { body: LOGIN_SCHEMA },
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const loginName = String(request.body.loginName);
      const password = String(request.body.password);

      const member = await repository.findMemberByLogin(workspaceId, loginName);
      const verified = await verifyOwnerPassword(member?.passwordHash ?? null, password, {
        equalisationDigest: app.timingEqualisationDigest,
      });

      if (member === null || !verified) {
        // A no-op when the workspace does not exist, so an unknown workspace and a wrong
        // password produce the same 401 after the same work. Auditing it through the ordinary
        // path would violate the audit foreign key and answer 500, which is an existence
        // oracle for anyone who can reach the route.
        // Never the presented login name. The field accepts any 3–64 character string, so a
        // password pasted into the login box would become a durable audit column. When the
        // member exists the server already knows its user id, which is both safe and more
        // useful; when it does not, there is no identity to name and the actor variant carries
        // none.
        await repository.recordAudit({
          actor:
            member === null
              ? { kind: 'unauthenticated', workspaceId }
              : { kind: 'member', workspaceId, userId: member.userId },
          action: 'session.login',
          outcome: 'denied',
        });
        return reply.code(401).send({
          code: 'AUTHZ_SCOPE_DENIED',
          message: 'invalid credentials',
          correlationId: request.id,
          retryable: false,
        });
      }

      // A fresh identifier per login, so a pre-authentication value cannot be fixed by an
      // attacker and then inherited by the authenticated session.
      const sessionId = randomBytes(32).toString('base64url');
      // The session and the record of it commit together: no live session exists without the
      // audit row that accounts for it.
      await repository.beginOwnerSession({
        workspaceId,
        userId: member.userId,
        sessionId,
        now: now(),
      });

      return reply
        .setCookie(cookieName, sessionId, sessionCookieOptions(options.secureCookies))
        .code(201)
        .send({ role: member.role, workspaceId });
    },
  );

  /**
   * Log out.
   *
   * Marks the server-side session revoked, so the cookie alone cannot resume it.
   *
   * Guarded by `requireOwnerSession`, not `requireAuthenticated`: an agent bearer credential
   * has no session to end, and allowing it here would let an agent write a `session.logout`
   * record attributed to an owner session that never existed.
   */
  app.delete<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/sessions/current',
    { onRequest: app.requireOwnerSession, preHandler: csrfProtection },
    async (request, reply) => {
      // Unsigned before use, like every other read of this cookie: revoking by an
      // unverified value would let a caller ask the server to revoke an arbitrary session.
      const raw = request.cookies[cookieName];
      const unsigned = raw === undefined ? null : request.unsignCookie(raw);
      const actor = request.principal;
      if (unsigned !== null && unsigned.valid && unsigned.value !== null && actor !== undefined) {
        // Revocation and its record commit together, so authority never ends unrecorded.
        await repository.endOwnerSession({
          sessionId: unsigned.value,
          reason: 'logout',
          // The principal the server resolved, never anything from the route. Its scope also
          // supplies the workspace the revocation is bound to.
          actor,
          now: now(),
        });
      }
      return reply
        .clearCookie(cookieName, sessionCookieOptions(options.secureCookies))
        .code(204)
        .send();
    },
  );

  /**
   * What the server resolved this caller to.
   *
   * Reports the principal derived from the credential's own stored row, which is what makes
   * the scoping observable: an agent sees its own bound pool and strategy and cannot report
   * anything wider, whatever it sent.
   */
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/principal',
    { onRequest: app.requireAuthenticated },
    async (request, reply) => {
      const actor = request.principal;
      if (actor === undefined) return reply.code(401).send();
      return reply.send({
        kind: actor.kind,
        role: actor.role,
        subjectId: actor.subjectId,
        scope: actor.scope,
      });
    },
  );

  /**
   * Issue an agent credential.
   *
   * The secret is generated here, sent once in this response, and never stored in recoverable
   * form. There is no route that returns it again.
   *
   * Atomicity below covers the database writes only. It cannot cover delivery: the response
   * may be lost in transit after COMMIT, and no server-side record can distinguish a secret
   * the caller received from one it did not. So a credential whose secret never arrived is a
   * possible outcome by construction, and the recovery is to rotate or reissue — not to
   * re-read a row.
   */
  app.post<{
    Params: { workspaceId: string; poolId: string; strategyId: string };
    Body: { label: string };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/strategies/:strategyId/credentials',
    {
      schema: { body: CREDENTIAL_LABEL_SCHEMA },
      onRequest: app.requireCapability('credential.issue'),
      preHandler: csrfProtection,
    },
    async (request, reply) => {
      const { workspaceId, poolId, strategyId } = request.params;
      return completeCredentialWrite(request, reply, {
        workspaceId,
        poolId,
        strategyId,
        label: request.body.label,
        rotatedFrom: null,
      });
    },
  );

  /**
   * The credentials of a strategy, metadata only.
   *
   * The recovery path for a lost issuance response: the owner finds the live credential's id
   * here and rotates it. Gated on credential.issue rather than a read capability, because
   * seeing which keys exist is administration of the strategy's authority, not observation of
   * its economics. No field here is or could be a secret; the response says so explicitly so a
   * client cannot mistake this for a place to fetch one.
   */
  app.get<{ Params: { workspaceId: string; poolId: string; strategyId: string } }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/strategies/:strategyId/credentials',
    { onRequest: app.requireCapability('credential.issue') },
    async (request, reply) => {
      const { workspaceId, poolId, strategyId } = request.params;
      const credentials = await repository.listAgentCredentials({
        workspaceId,
        poolId,
        strategyId,
      });
      return reply.send({
        credentials: credentials.map((credential) => ({
          credentialId: credential.credentialId,
          label: credential.label,
          createdAt: credential.createdAt.toISOString(),
          revealedAt: credential.revealedAt?.toISOString() ?? null,
          lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
          rotatedFrom: credential.rotatedFrom,
          revokedAt: credential.revokedAt?.toISOString() ?? null,
          revokedReason: credential.revokedReason,
          active: credential.revokedAt === null,
        })),
        secretRecoverable: false,
      });
    },
  );

  /**
   * Rotate an agent credential.
   *
   * A separate route and a separate capability. Rotation revokes a working key, which is a
   * different act from creating one where none existed, and an authorization model that
   * cannot express the difference cannot withhold one without withholding both. The credential
   * being replaced is named in the path, so the same scope tuple that guards every other
   * mutation covers it.
   */
  app.post<{
    Params: { workspaceId: string; poolId: string; strategyId: string; credentialId: string };
    Body: { label: string };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/strategies/:strategyId/credentials/:credentialId/rotations',
    {
      schema: { body: CREDENTIAL_LABEL_SCHEMA },
      onRequest: app.requireCapability('credential.rotate'),
      preHandler: csrfProtection,
    },
    async (request, reply) => {
      const { workspaceId, poolId, strategyId, credentialId } = request.params;
      return completeCredentialWrite(request, reply, {
        workspaceId,
        poolId,
        strategyId,
        label: request.body.label,
        rotatedFrom: credentialId,
      });
    },
  );

  /** Revoke an agent credential. Scoped, so another strategy's credential is not reachable. */
  app.delete<{
    Params: {
      workspaceId: string;
      poolId: string;
      strategyId: string;
      credentialId: string;
    };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/strategies/:strategyId/credentials/:credentialId',
    {
      onRequest: app.requireCapability('credential.revoke'),
      preHandler: csrfProtection,
    },
    async (request, reply) => {
      const { workspaceId, poolId, strategyId, credentialId } = request.params;
      const actor = request.principal;
      // requireCapability sets it; a route reached without one is a wiring error, not a state
      // to guess at.
      if (actor === undefined) return reply.code(401).send();
      const revoked = await repository.revokeAgentCredential({
        workspaceId,
        poolId,
        strategyId,
        credentialId,
        reason: 'owner revoked',
        actor,
        now: now(),
      });
      return revoked
        ? reply.code(204).send()
        : reply.code(404).send({
            code: 'AUTHZ_SCOPE_DENIED',
            message: 'not found',
            correlationId: request.id,
            retryable: false,
          });
    },
  );

  /**
   * A CSRF token for the console to attach to state-changing requests.
   *
   * Scoped under the workspace like every other route: an unscoped path would resolve to an
   * empty workspace id and be refused for every caller, and worse, a route that skipped the
   * scope check to work around that would be the one unscoped endpoint in the surface.
   */
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/csrf-token',
    // Owner sessions only. CSRF is a cookie-authentication problem; a bearer credential is not
    // attached by the browser and needs no token, so issuing one to an agent only hands it the
    // second half of a cookie-protected request it should not be making.
    { onRequest: app.requireOwnerSession },
    (_request, reply) => reply.send({ token: reply.generateCsrf() }),
  );

  /**
   * Perform a credential write and include its secret in exactly one response.
   *
   * The repository call is one transaction: the replaced key's revocation, the new row and the
   * audit record commit together or not at all. What that does not cover is the response. It
   * is formatted after COMMIT and can be lost in transit, and then a live credential exists
   * whose secret nobody holds. That outcome is real and recoverable: the credential list names
   * the live key, and rotation mints a new secret for it.
   */
  async function completeCredentialWrite(
    request: FastifyRequest<{
      Params: { workspaceId: string; poolId: string; strategyId: string };
    }>,
    reply: FastifyReply,
    write: {
      workspaceId: string;
      poolId: string;
      strategyId: string;
      label: string;
      rotatedFrom: string | null;
    },
  ): Promise<FastifyReply> {
    const actor = request.principal;
    if (actor === undefined) return reply.code(401).send();

    const credentialId = `cred-${randomBytes(9).toString('base64url')}`;
    const secret = generateSecret();

    const outcome = await repository.issueAgentCredential({
      workspaceId: write.workspaceId,
      poolId: write.poolId,
      strategyId: write.strategyId,
      credentialId,
      secret,
      label: write.label,
      rotatedFrom: write.rotatedFrom,
      actor,
      now: now(),
    });

    if (!outcome.ok) {
      if (outcome.reason === 'ACTIVE_CREDENTIAL_EXISTS') {
        // A typed decision, not a unique-violation surfacing as 500. The caller has already
        // proven credential.issue on this strategy, so naming its live key reveals nothing they
        // could not list; it is exactly what an owner whose issuance response was lost needs in
        // order to rotate.
        return reply.code(409).send({
          code: 'CREDENTIAL_ALREADY_ACTIVE',
          message:
            'this strategy already has an active credential; rotate it to obtain a new secret',
          correlationId: request.id,
          retryable: false,
          activeCredentialId: outcome.activeCredentialId,
        });
      }
      // 404 for both an unknown strategy and an unknown credential: distinguishing them would
      // confirm which identifiers exist inside a scope the caller may not be able to read.
      return reply.code(404).send({
        code: 'AUTHZ_SCOPE_DENIED',
        message: 'not found',
        correlationId: request.id,
        retryable: false,
      });
    }

    return reply.code(201).send({
      credentialId,
      // The only response that ever contains it.
      token: formatAgentToken({ environment: options.environment, credentialId, secret }),
      // "Sent once", not "received once". The server cannot observe delivery; if this response
      // is lost, the credential exists and its secret is unrecoverable, and the fix is a
      // rotation.
      displayedOnce: true,
    });
  }
}
