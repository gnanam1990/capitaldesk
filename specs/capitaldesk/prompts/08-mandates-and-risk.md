# Prompt 08 — Deterministic capital mandates and admission rules

**Dependencies:** Prompt 06, Prompt 07  
**Requirements:** FR-005, FR-009, FR-011, FR-013  
**Owns:** packages/domain policy engine and owner policy services

> **Amended by [ADR-0009](../../../docs/adr/0009-risk-policy-arithmetic.md).** Concentration,
> its denominator, HOUSE and fee-asset inclusion, the four freshness classes, the time
> sources and the fail-closed defaults are now exact. A missing freshness configuration
> refuses startup; an unpriceable denominator asset makes concentration `UNCOMPUTABLE` and
> blocks risk-increasing actions rather than valuing it at zero.

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 08 only.

Objective: Enforce owner authority separately from observed venue wealth.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Define versioned strategy/pool limits: selected symbol, assets, max plan debit, daily gross BUY budget, concentration, freshness, expiry and buy-inhibit mandate.
2. Use actual claim ownership and reserved budgets. Another strategy's cash and expected sale proceeds cannot fund a candidate.
3. Handle UTC budget buckets consistently across approval expiry and in-flight midnight transitions as TDD specifies; filled notional remains consumed after cancel/expiry.
4. Owner changes invalidate affected unmarked plans. Already marked attempts remain in flight and are not claimed to be cancelled.
5. Agents cannot escalate priority, alter policies or bypass an owner halt through prompt content.
6. Return deterministic reason codes and explanations derived from actual policy inputs. AI prose cannot be an authorization result.

Required verification:
T-005–T-008, T-012–T-013, T-018–T-020, T-040; midnight, budget revision and same-pool concurrent budget exhaustion.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
A venue snapshot showing surplus funds cannot override an insufficient strategy authorization.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/08.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

