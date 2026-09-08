import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Capability, Principal } from '@capitaldesk/domain';
import { authenticateRequest, requestedScopeFrom } from './authenticate.js';
import { authorize } from '@capitaldesk/domain';
import { IdentityRepository } from './repository.js';

/**
 * Wiring for owner sessions and agent credentials.
 *
 * The session identifier lives in a cookie and the session state lives in PostgreSQL, so
 * revoking a session — setting `revoked_at` on its row, never deleting it — is observed by
 * the next request, rather than being a claim that stays valid inside a signed cookie until
 * it expires. The row survives as evidence of when the session existed and when it ended.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set only after successful authentication. Never populated from request input. */
    principal?: Principal;
  }
}

export interface AuthPluginOptions {
  readonly repository: IdentityRepository;
  readonly environment: string;
  /** True for any deployment served over HTTPS; drives the cookie prefix and Secure flag. */
  readonly secureCookies: boolean;
  /**
   * The resolved OWNER_SESSION secret, never its reference.
   *
   * Resolved once at startup by `resolveOwnerSessionSecret` and passed only here. It is
   * deliberately not carried on the config object, so it cannot travel to a logger, an
   * export or another process alongside ordinary settings.
   */
  readonly sessionSecret: string;
  readonly now?: () => Date;
}

export const SESSION_COOKIE_SECURE = '__Host-capitaldesk-session';
export const SESSION_COOKIE_PLAIN = 'capitaldesk-session';

/**
 * `__Host-` requires Secure, which requires HTTPS.
 *
 * Local development is served over plain HTTP, where the prefix would make the browser reject
 * the cookie outright. The prefix is therefore tied to the same flag as Secure, so a
 * production deployment always gets the strongest form and development gets a working one —
 * rather than an exception that has to be remembered.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
}

export function sessionCookieOptions(secure: boolean): {
  path: string;
  signed: true;
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
} {
  return {
    path: '/',
    // Signed, and verified on read. An unsigned cookie is one a caller can mint.
    signed: true,
    // Not readable from script, so an XSS cannot exfiltrate the session.
    httpOnly: true,
    // Strict, not Lax: no cross-site navigation should carry authority for a console that
    // approves financial actions. The console reaches the API same-origin, so nothing
    // legitimate is cross-site.
    sameSite: 'strict',
    secure,
  };
}

async function authPlugin(app: FastifyInstance, options: AuthPluginOptions): Promise<void> {
  const now = options.now ?? ((): Date => new Date());
  const cookieName = sessionCookieName(options.secureCookies);

  await app.register(fastifyCookie, { secret: options.sessionSecret });
  await app.register(fastifyCsrf, { cookieOpts: { signed: true } });
  await app.register(fastifyRateLimit, {
    global: false,
    // Keyed by source address. Bounded so a credential-stuffing attempt is slowed without a
    // shared store; a distributed store arrives with the deployment work in module 27.
    keyGenerator: (request: FastifyRequest) => request.ip,
  });

  app.decorateRequest('principal', undefined);

  /**
   * Authenticate every request that reaches a guarded route.
   *
   * Registered as a decorator rather than a global hook, so an unguarded route cannot
   * accidentally inherit an authenticated principal, and a guarded one cannot forget to
   * authenticate.
   */
  /**
   * Authenticate without requiring a capability.
   *
   * Introspecting your own principal is not an action on a pool, and a pool-bound agent can
   * never satisfy a workspace-only scope check — so requiring a scoped capability here would
   * make the route unreachable for exactly the callers who most need it.
   */
  app.decorate(
    'requireAuthenticated',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const outcome = await authenticateRequest(request, {
        repository: options.repository,
        environment: options.environment,
        cookieName,
        now: now(),
      });
      if (!outcome.ok) {
        await reply.code(401).send({
          code: 'AUTHZ_SCOPE_DENIED',
          message: 'authentication required',
          correlationId: request.id,
          retryable: false,
        });
        return;
      }
      // Still workspace-bound: a principal may only introspect inside its own workspace.
      const params = request.params as Record<string, string | undefined>;
      if (params['workspaceId'] !== outcome.principal.scope.workspaceId) {
        await reply.code(404).send({
          code: 'AUTHZ_SCOPE_DENIED',
          message: 'not found',
          correlationId: request.id,
          retryable: false,
        });
        return;
      }
      request.principal = outcome.principal;
    },
  );

  /**
   * Authenticate, and require a human cookie session specifically.
   *
   * Some routes are about the session itself — ending it, or minting the CSRF token that
   * protects it. `requireAuthenticated` accepts an agent bearer credential, which is right for
   * introspection and wrong here: an agent could fetch a CSRF token, call session logout and
   * leave an `owner-session` audit record naming its own credential id. That is a forged
   * owner action in the trail, written by a principal that has no session at all.
   *
   * Token class is therefore part of the authorization decision for these routes, not only
   * capability.
   */
  app.decorate(
    'requireOwnerSession',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const outcome = await authenticateRequest(request, {
        repository: options.repository,
        environment: options.environment,
        cookieName,
        now: now(),
      });
      const params = request.params as Record<string, string | undefined>;
      if (
        !outcome.ok ||
        outcome.principal.kind !== 'owner-session' ||
        params['workspaceId'] !== outcome.principal.scope.workspaceId
      ) {
        await reply.code(401).send({
          code: 'AUTHZ_SCOPE_DENIED',
          message: 'authentication required',
          correlationId: request.id,
          retryable: false,
        });
        return;
      }
      request.principal = outcome.principal;
    },
  );

  app.decorate(
    'requireCapability',
    (capability: Capability) =>
      async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const outcome = await authenticateRequest(request, {
          repository: options.repository,
          environment: options.environment,
          cookieName,
          now: now(),
        });

        if (!outcome.ok) {
          // 401 for "we do not know who you are", never 403: distinguishing them here would
          // tell an unauthenticated caller whether a resource exists.
          await reply.code(401).send({
            code: 'AUTHZ_SCOPE_DENIED',
            message: 'authentication required',
            correlationId: request.id,
            retryable: false,
          });
          return;
        }

        const scope = requestedScopeFrom({
          params: request.params as Record<string, string | undefined>,
        });

        const decision = authorize(outcome.principal, capability, scope);
        if (!decision.allowed) {
          // The record names the principal's own scope and a closed refusal code — never the
          // path segments the caller supplied. Those reach no column: `audit_events.pool_id`
          // and `strategy_id` used to take them directly, which made a denied request a way
          // to persist arbitrary text next to an audit row, outside the detail schema. No
          // regex separates a pool id from a token shaped like one, so the answer is that
          // there is nowhere for the value to go.
          await options.repository.recordAudit({
            actor: { kind: 'principal', principal: outcome.principal },
            action: capability,
            outcome: 'denied',
            detail: { capability, refusal: decision.reason },
          });
          // 404, not 403: telling a caller that a resource exists but is forbidden confirms
          // the identifier, which is how another tenant's object graph gets mapped.
          await reply.code(404).send({
            code: 'AUTHZ_SCOPE_DENIED',
            message: 'not found',
            correlationId: request.id,
            retryable: false,
          });
          return;
        }

        request.principal = outcome.principal;
      },
  );
}

export default fp(authPlugin, { name: 'capitaldesk-auth', fastify: '5.x' });

declare module 'fastify' {
  interface FastifyInstance {
    requireCapability: (
      capability: Capability,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAuthenticated: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOwnerSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
