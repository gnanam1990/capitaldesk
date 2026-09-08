# ADR-0012 — Owner authentication, sessions and agent credentials

- Status: accepted
- Date: 2026-09-08
- Implements: module 03 (identity and access)
- Depends on: ADR-0007 (credential classes)
- Amends: TDD section 4; prompt 03

## Context

Module 03 has to answer three questions before any economic module can be written: how the
owner proves who they are, how that proof is carried across requests, and how an agent gets
enough authority to propose without ever being able to act.

The failure mode that matters is not a broken hash. It is a scope that widens: an identifier
from one pool authorizing a write in another, a caller-supplied field selecting a role, an
agent credential that keeps working after it was revoked. Each of the decisions below is
chosen for what it makes impossible, and the ones that only make something unlikely are named
as such.

## Decision

### 1. No default owner. Bootstrap is a one-time code redeemed at a terminal

An operator with database access runs `enroll issue`, which prints a single-use code once and
stores only its Argon2id digest. `enroll redeem` exchanges that code for the owner account.

There is no default account, no default password, and no shared bootstrap secret — each of
those is a credential that exists before anyone chose it, and the ones that are never rotated
are the ones that end up in a support ticket.

**Alternatives considered.** Email or SMS delivery of the code adds an external dependency and
a second account-recovery surface to solve a problem an operator can solve at the terminal
they already have. An OAuth provider moves the trust root to a third party, which is the wrong
direction for a console that governs a funded account.

**Limitation.** Anyone with write access to the database can mint an enrollment code, so the
database is the trust root for bootstrap. This is deliberate — it is already the trust root
for balances — but it means database access must be governed as tightly as owner access.

### 2. TOTP is deferred, and this is a limitation rather than a decision

A second factor would meaningfully raise the cost of a stolen password. It is not implemented
in this milestone: it is not required by the governing specs here, and the enrollment and
recovery flows it needs are their own design. Recorded as an open gap, not as a completed
control.

### 3. Argon2id for human secrets, SHA-256 for high-entropy ones

Passwords, enrollment codes and agent secrets are stored as Argon2id digests at the OWASP
minimum (m=19456, t=2, p=1) via `@node-rs/argon2`. A database CHECK refuses any digest that is
not `$argon2id$…`, so a downgrade is a write error rather than a code review miss.

Session identifiers are 32 random bytes and are stored as a plain SHA-256 digest. Stretching a
256-bit random value buys nothing against a search of that space, and it would put an Argon2id
computation on every authenticated request.

### 4. Sessions are server-side rows, not signed claims

12 hours absolute, 30 minutes idle. The cookie carries an identifier; the state lives in
PostgreSQL. Expiry, revocation, membership and account status are evaluated in the same
statement that reads the row and slides the idle window, so no request can observe a session
between the read and the check.

Revocation sets `revoked_at`; nothing is deleted, so the trail still shows when the session
existed and when its authority ended.

A disabled user fails closed at resolution because the resolving statement joins `users` and
requires `disabled_at IS NULL`. Correctness does not depend on a separate revoke-all call
having run and having missed nothing.

**Alternative considered.** A signed JWT needs no lookup, and cannot be revoked before it
expires. For a console that approves financial actions, "the owner cannot revoke this for
another eleven hours" is not an acceptable property.

### 5. Cookies: signed, HttpOnly, SameSite=Strict, `__Host-` where HTTPS allows

The signing key is the resolved OWNER_SESSION secret, read at startup from the `file://`
reference. An earlier draft signed with the _reference string_, which would have given every
deployment using the same conventional path an identical, guessable key — and would never have
read the mounted secret at all.

Cookies are signed on write and signature-verified on every read. Registering a secret does
not make `request.cookies` trustworthy: it returns whatever arrived. `request.unsignCookie()`
is the check, and every read of the session cookie goes through it.

`SameSite=Strict` means the console must be same-origin with the API. Next proxies `/api/*` to
the API rather than the cookie being relaxed to `Lax` or CORS being opened with credentials:
weakening a production control to accommodate a development layout is how the control stops
being one.

### 6. CSRF and session lifecycle require a human cookie session

State-changing owner routes carry a double-submit CSRF token. The routes that manage the
session itself — logout, and minting the CSRF token — require a principal of kind
`owner-session` specifically, not merely an authenticated one. An agent bearer credential has
no session to end, and accepting one there let an agent write a `session.logout` record
attributed to an owner session that never existed.

### 7. Agent credentials are strategy-scoped, single-active, and shown once

A credential is bound through the complete `(workspace, pool, strategy)` tuple by a composite
foreign key, so a real credential id presented under a different real pool is refused by the
database and not by a code path that might be forgotten. One active credential per strategy is
a partial unique index. Rotation names its predecessor through the same complete tuple.

Issue and rotate are separate routes with separate capabilities. Rotation revokes a working
key, which is a different act from creating one where none existed, and an authorization model
that cannot express the difference cannot withhold one without withholding both.

Every credential write — the revoke, the insert and the audit record — runs in one transaction
on one checked-out connection.

**Limitation, stated plainly.** That transaction covers the database and nothing else. Whether
the one-time response reached its recipient is not a property a COMMIT can establish, so a
committed credential whose secret nobody received is a possible outcome by construction. The
recovery is rotation; there is no route that returns a secret again, and `revealed_at` records
that a display was attempted, not that it arrived.

### 8. Authorization checks capability and scope independently

`authorize()` is pure and checks the capability against a closed grant matrix, then checks the
requested scope against the principal's own bound scope. An omitted scope is
`SCOPE_NOT_SPECIFIED` and never widens. `venue.dispatch` exists in the capability set so it
can be named and denied: no role holds it and no route exposes it.

Agents hold `intent.propose` and four read capabilities. They cannot seal, approve, reserve,
reallocate, administer or dispatch.

### 9. Principals come from stored rows only

The pure `principal()` factory validates shape; it does not establish provenance, and it is
exported, so it will accept any well-formed object. Provenance is enforced at the adapter: the
repository builds a principal only from columns it has just read, and — for agent credentials
— only from the `RETURNING` clause of the guarded update that confirms the credential is still
active. A revocation that commits during Argon2id verification therefore wins.

No `FOR UPDATE` is taken across verification. Locking would serialise every request for a
credential behind one Argon2id computation, and it would let authentication beat a revocation
that arrived during it. Revocation should win that tie.

### 10. Audit columns are populated by provenance, not by filtering

`audit_events` does not pass through the logger's redaction — it goes straight to PostgreSQL —
so the boundary has to be at the write. It is two things, and the second is the one that
matters:

- `detail` passes a closed key schema with a shape per key. Value-shape scrubbing alone is
  insufficient: a 43-character base64url agent secret and a chosen password match no known
  secret pattern.
- `actor_id`, `pool_id` and `strategy_id` are derived from an `AuditActor` — a principal the
  authenticator built from stored rows, a member row the repository just read, or no identity
  at all — or from a strategy tuple the same transaction has just confirmed against the
  database. There is no parameter through which a route can pass a path segment. An earlier
  draft copied the requested pool and strategy into a denial record, which made any denied
  request a way to persist arbitrary text; no regex can tell a pool id from a token shaped like
  one, so the fix is that the value has nowhere to go.

A failed login records the user id when the member exists and a fixed `unauthenticated` marker
when it does not — never the string typed into the login field, which accepts any 3–64
characters and would otherwise make a pasted password durable.

### 11. A failed login never reveals whether a workspace exists

The audit insert has a foreign key to `workspaces`. Writing an unauthenticated denial through
that path raised a constraint violation and answered 500 for an unknown workspace while a wrong
password answered 401 — a status code that told any caller which workspaces exist. Denials from
unauthenticated callers are written with `INSERT … SELECT … WHERE EXISTS`, so the write is a
no-op for an unknown workspace and the response is identical after identical Argon2id work.

## Consequences

- The console cannot be served cross-origin from the API without changing the cookie policy.
- Losing the owner password with no other owner means re-running enrollment at the database.
  There is no self-service reset, and adding one would add a recovery surface.
- Every credential mutation costs a pooled connection for the length of the transaction.
- Bootstrap security equals database access security.

## What is not proven

- No real terminal has been driven. Echo suppression is proven over injected streams in
  `apps/api/src/cli/input-session.test.ts`; raw-mode restore on a real tty is a manual check
  recorded in `docs/handoffs/03.md`.
- No venue credential exists, so nothing here has been exercised against Binance.
- Rate limiting is per-process and in-memory. It slows a single-source attempt and does nothing
  about a distributed one; a shared store arrives with the deployment work.
