# ADR-0009 — Exact risk arithmetic, freshness and fail-closed defaults

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F9 (Medium)
- Amends: TDD section 7; PRD section 10; TEST-PLAN section 6; prompt 08

## Context

"Pool concentration" appeared as a named control without a numerator, denominator, valuation
price, HOUSE treatment, fee-asset treatment or stale-price behaviour. The PRD expects freshness
defaults and rationale in the TDD; the TDD defers the values to measurement. Deferring a
*measured* value is right; leaving the *configuration contract* and the fail-closed default
missing is not.

## Decision

### 1. Concentration, exactly

For strategy `s` and asset `a`, valued in the pool's reference quote asset `Q`:

```
value(s, a)   = claims(s, a, AVAILABLE + RESERVED + QUARANTINED) x referencePrice(a -> Q)
concentration(s, a) = value(s, a) / sum over every owner o and asset b of value(o, b)
```

- The denominator **includes** HOUSE claims and fee assets. Excluding HOUSE would let an
  owner reduce measured concentration by leaving inventory unassigned.
- Quarantined claims are included: they are still owned, just unusable.
- All arithmetic is exact integer atoms; the ratio is compared as a rational
  (`numerator x limitDenominator` vs `denominator x limitNumerator`), never as a float.

### 2. Unpriceable assets fail closed

If any asset in the denominator has no reference price inside its freshness class,
concentration is `UNCOMPUTABLE` and every risk-increasing action is blocked with
`POLICY_CONCENTRATION_UNCOMPUTABLE`. It is never treated as zero, and never skipped.

### 3. Freshness classes

| Class | Applies to | Behaviour when exceeded |
|---|---|---|
| `PRICE_SNAPSHOT` | reference prices for valuation | concentration UNCOMPUTABLE |
| `ACCOUNT_SNAPSHOT` | balances backing capacity checks | dispatch blocked, `EVIDENCE_STALE` |
| `SYMBOL_METADATA` | filters, lot and tick sizes | planning blocked |
| `VENUE_CLOCK` | measured venue clock offset | dispatch blocked, `CLOCK_SKEW_UNBOUNDED` |

Each maximum age is required configuration with **no default**. A missing value is a startup
refusal (`POLICY_CONFIGURATION_MISSING`), because a default here silently decides how stale
evidence may be before it authorizes a trade.

### 4. Time sources

- Eligibility and expiry: venue `serverTime`, via the measured offset with its skew budget.
- Latency budgets: local monotonic clock, never wall clock.
- Reporting and daily buckets: UTC wall clock.
- A database/application clock disagreement beyond the skew budget blocks dispatch.

### 5. Observed value versus worst-case reservation

Budget checks use two distinct quantities, both retained: the **observed** committed value
from booked fills, and the **worst-case** outstanding value from reservation ceilings.
Admission uses committed + worst-case outstanding. Recovering risk budget by cancelling after
an actual fill is prohibited.

### 6. One policy version

Preview and dispatch evaluate the same `mandatePolicyVersion`, which is bound into the plan
digest. A policy published between preview and dispatch invalidates the unmarked plan
(ADR-0006).

## Tests

Independent boundary fixtures for concentration including zero denominators, HOUSE-only pools,
an unpriceable asset, a stale fee-asset price, the UTC midnight boundary and partially filled
outstanding exposure; a missing freshness configuration refusing startup.
