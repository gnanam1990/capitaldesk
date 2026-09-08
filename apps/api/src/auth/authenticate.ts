import type { FastifyRequest } from 'fastify';
import type { Capability, Principal, RequestedScope } from '@capitaldesk/domain';
import { authorize } from '@capitaldesk/domain';
import { hashHumanSecret, parseAgentToken, verifyHumanSecret } from './secrets.js';
import type { IdentityRepository } from './repository.js';

/**
 * The provenance boundary.
 *
 * Everything a principal knows about itself is read here, from the database, using only a
 * credential the caller proved possession of. No field is taken from the body, the query
 * string, or any header other than the credential itself. That is the module's acceptance
 * gate: no agent-controlled field selects its owner, permission level or execution account.
 *
 * The pure `principal()` factory cannot enforce this — it validates shape and would accept a
 * forged object just as readily. This function is where the guarantee lives, and the route
 * tests that post forged identity fields are what prove it.
 */

export const SESSION_COOKIE = '__Host-capitaldesk-session';
/** The cookie name without the prefix, for local HTTP development where `__Host-` cannot be set. */
export const SESSION_COOKIE_INSECURE = 'capitaldesk-session';

export type AuthenticationFailure =
  | 'NO_CREDENTIAL'
  | 'BOTH_CREDENTIAL_KINDS'
  | 'MALFORMED_TOKEN'
  | 'UNSIGNED_OR_TAMPERED_COOKIE'
  | 'UNKNOWN_OR_REVOKED'
  | 'WRONG_ENVIRONMENT';

export type AuthenticationResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly failure: AuthenticationFailure };

/**
 * A dummy Argon2id digest, hashed once at startup.
 *
 * Verified against when no user matches, so a missing login and a wrong password cost the
 * same. Without it the response time distinguishes them and the endpoint enumerates accounts.
 */
let dummyDigestPromise: Promise<string> | null = null;
function dummyDigest(): Promise<string> {
  dummyDigestPromise ??= hashHumanSecret('capitaldesk-timing-equalisation-placeholder');
  return dummyDigestPromise;
}

export interface AuthenticateOptions {
  readonly repository: IdentityRepository;
  readonly environment: string;
  readonly cookieName: string;
  readonly now: Date;
}

/**
 * Authenticate a request from exactly one credential.
 *
 * A request carrying both a session cookie and a bearer token is rejected outright rather
 * than resolved by precedence. Precedence rules are where confusion attacks live, and no
 * legitimate caller sends both.
 */
export async function authenticateRequest(
  request: FastifyRequest,
  options: AuthenticateOptions,
): Promise<AuthenticationResult> {
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> })
    .cookies;
  const rawSessionCookie = cookies?.[options.cookieName];

  const authorization = request.headers.authorization;
  const bearer =
    typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : undefined;

  if (rawSessionCookie !== undefined && bearer !== undefined) {
    return { ok: false, failure: 'BOTH_CREDENTIAL_KINDS' };
  }

  if (rawSessionCookie !== undefined) {
    // `request.cookies` holds whatever the client sent. Registering a secret with
    // @fastify/cookie does not make it trustworthy: the value must be unsigned explicitly,
    // and a cookie that was never signed unsigns just as unsuccessfully as a tampered one.
    // Without this, a caller could mint their own cookie value and have it hashed and looked
    // up as though the server had issued it.
    const unsigned = request.unsignCookie(rawSessionCookie);
    if (!unsigned.valid || unsigned.value === null) {
      return { ok: false, failure: 'UNSIGNED_OR_TAMPERED_COOKIE' };
    }
    const resolved = await options.repository.resolveSession(unsigned.value, options.now);
    return resolved === null
      ? { ok: false, failure: 'UNKNOWN_OR_REVOKED' }
      : { ok: true, principal: resolved };
  }

  if (bearer !== undefined) {
    const token = parseAgentToken(bearer);
    if (token === null) return { ok: false, failure: 'MALFORMED_TOKEN' };
    // A token minted for another environment is refused before it is looked up, so a testnet
    // credential cannot authenticate against a differently configured deployment.
    if (token.environment !== options.environment) {
      return { ok: false, failure: 'WRONG_ENVIRONMENT' };
    }
    const resolved = await options.repository.resolveAgentCredential(
      token.credentialId,
      token.secret,
      options.now,
    );
    return resolved === null
      ? { ok: false, failure: 'UNKNOWN_OR_REVOKED' }
      : { ok: true, principal: resolved };
  }

  return { ok: false, failure: 'NO_CREDENTIAL' };
}

/**
 * Verify an owner password in constant-ish time.
 *
 * Always performs one Argon2id verification, even when no member matched, so the endpoint
 * does not reveal which login names exist.
 */
export async function verifyOwnerPassword(
  storedHash: string | null,
  presented: string,
): Promise<boolean> {
  if (storedHash === null) {
    await verifyHumanSecret(await dummyDigest(), presented);
    return false;
  }
  return verifyHumanSecret(storedHash, presented);
}

export interface ScopeSource {
  readonly params: Record<string, string | undefined>;
}

/**
 * Build the requested scope from the URL path only.
 *
 * Path parameters, never the body: a scope read from the body would let a caller name the
 * pool it wishes to act on independently of the resource it addressed.
 */
export function requestedScopeFrom(source: ScopeSource): RequestedScope {
  const scope: {
    workspaceId: string;
    poolId?: string | undefined;
    strategyId?: string | undefined;
  } = { workspaceId: source.params['workspaceId'] ?? '' };
  if (source.params['poolId'] !== undefined) scope.poolId = source.params['poolId'];
  if (source.params['strategyId'] !== undefined) scope.strategyId = source.params['strategyId'];
  return scope;
}

export function mayPerform(
  actor: Principal,
  capability: Capability,
  scope: RequestedScope,
): boolean {
  return authorize(actor, capability, scope).allowed;
}
