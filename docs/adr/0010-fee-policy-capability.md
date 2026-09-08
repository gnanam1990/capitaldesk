# ADR-0010 — One initially supported fee policy, gated on a proven bound

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F10 (Medium)
- Amends: TDD section 6; TEST-PLAN sections 4 and 11; prompts 00, 14

## Context

The review accepts the controlled-rounding approach and is precise about what the evidence
does *not* cover: an independently enumerated 5x2 oracle for T-055 supports the chosen
method, but does not prove the general circulation construction, arbitrary combined fee
subcaps, or every permitted exchange fill partition.

It also names a concrete hazard. Binance documents BNB commission falling back to the
received asset when the BNB balance is insufficient, so a BNB-only reservation assumption can
be incomplete: the debited asset can change mid-order.

The hard boundary is already acknowledged in the pack: an observed *rate* does not establish
a conservative cumulative *debit bound* across all partial fills with native rounding.

## Decision

### 1. A fee policy is a capability, and it can be disabled

Every policy declares whether a conservative cumulative debit bound has been proven for every
permitted partial fill. `cumulativeBoundProven: false` means dispatch is refused with
`FEE_BOUND_UNPROVEN`. There is no "assume the rate" path.

### 2. The one initially enabled policy: `STANDARD_NO_BNB_V1`

- Commission is taken in the **received asset**: base on a BUY, quote on a SELL, at the
  verified per-symbol rate. This matches Binance's standard schedule.
- Per-fill ceiling is `ceil(rate x fillQuantity)` in that asset. The cumulative bound is the
  sum of per-fill ceilings, which terminates because IOC execution cannot exceed the
  requested quantity.
- Requires the account's BNB fee payment to be **verified disabled**. If that setting cannot
  be read — plausible on testnet — the capability is `UNVERIFIED` and any observed BNB
  commission quarantines rather than being absorbed.
- Consequence to state plainly in the UI: a fully filled BUY leaves net base below target by
  the base commission, and no second order is created automatically.

### 3. `BNB_DISCOUNT_UNPROVEN` is defined and disabled

Defined so the code can name and refuse it, disabled because the documented insufficiency
fallback has no proven bound. Enabling it later requires proving the fallback bound, not
relaxing this decision.

### 4. `QUOTE_FEE_FIXTURE_V1` is fixture-only

The reviewed golden example charges a 0.1% quote fee on a BUY, which the standard schedule
does not. The pack labels it fixture policy, and it stays exactly that: the golden numbers
remain reproducible, and the policy is refused outside the `local` environment. This is why
the amendment creates no contradiction with TDD section 6.

### 5. Caps are per asset and per direction

BUY quote cost and quote-denominated commission share one quote-debit cap; base commission on
a BUY has its own cap against the acquired base. Caps are bound into the plan digest, and an
observed fee above a cap preserves the fact and quarantines — it never raises the cap,
borrows from another strategy or inserts a HOUSE plug.

### 6. What the oracle proves

The exhaustive oracle covers the T-055 5x2 matrix. It is recorded as supporting evidence for
the method, not as proof of the general solver. The general implementation owes pseudocode, a
worked shared cost/commission graph, a lower-bounded circulation reduction, a deterministic
traversal order and small exhaustive-oracle coverage — all in module 14, none claimed here.

## Consequences

The first authenticated integration must read the account's commission rates and BNB burn
setting before any dispatch. If either is unreadable, governed execution is blocked rather
than attempted under an assumed schedule.

## Tests

Fee charged in quote, base and BNB; unsupported or unowned fee asset; a fee above the approved
bound; fee-asset change within one child order; infeasible combined caps; the fixture policy
refused outside `local`. Extends T-016, T-017, T-018, T-055, T-057, T-058.
