# ADR-0008 — When the candidate set closes

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F8 (Medium)
- Amends: TDD section 7; PRD section 6; TEST-PLAN section 5; prompts 09, 10, 11

## Context

An approved BUY may wait while a different strategy submits a new SELL. The plan hash binds
participating revisions but says nothing about the candidate-set cutoff, so one implementation
defers the newcomer to the next cycle and another blocks the old plan. Both are defensible and
they are not the same product.

## Decision

### 1. The cohort closes at seal

Sealing binds `cohortClosedAtSequence`, the accepted-sequence at which candidates stopped
being eligible. It is part of the plan digest, so the owner approves a specific cohort rather
than "whatever was pending".

### 2. New proposals are always accepted

A proposal arriving while a plan is sealed or in flight is never rejected. It is recorded as
`QUEUED_NEXT_COHORT`. Rejecting an agent's proposal because of unrelated timing would push
agents toward retry loops.

### 3. Late opposing intent

- **Before `DISPATCH_MARKED`:** a new opposing intent for the same symbol invalidates the
  sealed-but-unmarked plan with `PLAN_INVALIDATED_BY_OPPOSING_INTENT`, releasing its
  reservations. The owner sees the conflict and decides. Safety first: the order has not left.
- **After `DISPATCH_MARKED`:** the plan is untouched, because the order cannot be recalled.
  The opposing intent queues and the console shows both facts — an order in flight and a
  queued opposing intent — without implying either cancels the other.

### 4. Ineligible participants are excluded before conflict evaluation

Expired, superseded, deferred, unauthorized and zero-delta intents are removed with their
stable reason codes **before** opposite-direction evaluation. Otherwise an expired SELL would
create an account-wide CONFLICT and block an otherwise valid BUY — a denial-of-service by an
agent that has stopped participating.

### 5. Deferral scope

Owner deferral binds the `strategyTargetKey` (ADR-0006), so a newer revision from the same
strategy stays deferred until the owner reinstates.

## Consequences

An owner approving a plan may see it invalidated by a late opposing proposal. The console must
explain which intent invalidated it and why, otherwise this reads as a system fault rather
than the coordination the product exists to provide.

## Tests

Opposite proposal before seal, after seal, after approval and after marker; deferral followed
by a newer revision; repeated satisfied targets; invalid or expired proposals attempting to
block an otherwise valid plan. Extends T-005, T-008.
