# ADR-0006 — The owner lifecycle actions the API never defined

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F6 (Medium)
- Amends: TDD section 11; UI-UX sections 5 and 9; prompts 03, 07, 17, 23

## Context

The UI promises owner defer/revise, policy management and credential lifecycle. The route
table has proposal creation and credential issuance, and nothing else: no defer or reinstate,
no policy update, no credential revoke or rotate, no strategy archive, no account link or
pool lifecycle. Since the TDD is stated to define exact contracts, this left several sessions
free to invent consequential mutations independently.

## Decision

### 1. One frozen table

Every lifecycle action declares: allowed actor scopes, idempotency scope, whether an expected
version is required, its emitted event, and its effect on a sealed plan. The table lives in
`packages/contracts/src/lifecycle.ts` so the API, the console and the tests read the same
source rather than three drifting copies.

Actions: `INTENT_DEFER`, `INTENT_REINSTATE`, `POLICY_VERSION_PUBLISH`, `CREDENTIAL_ISSUE`,
`CREDENTIAL_REVOKE`, `CREDENTIAL_ROTATE`, `STRATEGY_ARCHIVE`, `ACCOUNT_LINK`,
`ACCOUNT_UNLINK`, `POOL_CREATE`, `POOL_HALT`, `POOL_RESUME`, `POOL_EPOCH_ROTATE`.

### 2. Authorization is an allowlist, not one required role

Each action carries `allowedActors`. An early draft named a single required role and compared
for equality, which locked the pool's own owner out of `POOL_HALT` — their own kill switch —
because halting was labelled an operator action. Owner and operator may both halt; only the
owner may resume, because resuming is the decision that reintroduces risk. Agents and viewers
may perform no lifecycle mutation at all.

### 3. Effect on a plan, resolved against where that plan actually is

- **Unmarked** (`SEALED_AWAITING_APPROVAL`, `APPROVED`, `DISPATCH_PENDING`): an
  `INVALIDATE_UNMARKED` action invalidates the plan and releases its reservations in the same
  transaction that makes it undispatchable.
- **Marked** (`EXECUTING`, `RECONCILING`, `MANUAL_REVIEW`): the action takes effect on
  **future dispatch authority only**. It does not invalidate the in-flight plan, does not
  release or alter its reservations, and is not a cancellation of anything the venue has
  accepted. An owner halt is a durable refusal to dispatch again; the console must show the
  requested halt and the exchange-confirmed state as separate facts.
- `ACCOUNT_UNLINK` and `POOL_EPOCH_ROTATE` are refused outright while a dispatch is in flight,
  because their meaning would be incoherent under a possibly live order.

An earlier draft's comment claimed marked plans were refused outright while the code permitted
them. Neither was right, and the ambiguity is exactly the kind that produces two
implementations. The resolution is now explicit and tested in both directions.

### 4. Deferral binds the target, not one revision

An owner deferral binds the `strategyTargetKey`, not the revision it was applied to, and
persists until the owner reinstates or an explicit `untilAt` passes. Without this, an agent's
revision N+1 would silently escape the owner's decision — which is the failure the review
asked us to prevent.

## Consequences

Every lifecycle route needs `If-Match`-style expected versions and an idempotency scope; the
console must surface a stale-version conflict rather than retrying blindly.

## Tests

Owner and operator halt; operator refused resume; agent and viewer refused every action;
each action's resolved effect at marked and unmarked plan states; no action ever resolving to
INVALIDATE while marked; deferral surviving a newer revision; replay after revocation.
Extends T-040.
