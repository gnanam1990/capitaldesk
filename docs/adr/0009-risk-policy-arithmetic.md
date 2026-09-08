# ADR-0009 — Exact risk arithmetic, freshness and fail-closed defaults

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F9 (Medium)
- Amends: TDD section 7; PRD section 10; TEST-PLAN section 6; prompt 08

## Context

"Pool concentration" appeared as a named control without a numerator, denominator, valuation
price, HOUSE treatment, fee-asset treatment or stale-price behaviour. The PRD expects freshness
defaults and rationale in the TDD; the TDD defers the values to measurement. Deferring a
_measured_ value is right; leaving the _configuration contract_ and the fail-closed default
missing is not.

## Decision

### 1. Pool concentration is summed across every owner

For asset `a`, valued in the pool's reference quote asset `Q`:

```
poolAssetExposure(a) = sum over EVERY owner o, strategies and HOUSE alike, of
                       claims(o, a, AVAILABLE + RESERVED + QUARANTINED) x referencePrice(a -> Q)

poolTotal            = sum over every asset b of poolAssetExposure(b)

poolConcentration(a) = poolAssetExposure(a) / poolTotal
```

The numerator is the **pool's** exposure, not one strategy's holding. An earlier version
divided a single strategy's holding by the pool total, and maintainer review showed that this
makes the control defeatable by an ownership reassignment that moves no funds: a pool worth
1000 holding 600 of one asset is 60% concentrated in it, but split across three strategies at
200 each every per-strategy figure reads 20% and passes a 50% limit. Summing across all
owners makes the measure invariant under reassignment and splitting, which is the property a
concentration limit needs.

Quarantined claims are included — they are still owned, merely unusable. HOUSE is included;
excluding it would let an owner reduce measured concentration by leaving inventory
unassigned. Fee assets are included.

All arithmetic is exact integer atoms compared as rationals by cross-multiplication
(`exposure x limitDenominator > total x limitNumerator`), never division and never a float.

### 1a. A separate per-strategy limit, for a different question

`strategyShareOfPool(s)` is the fraction of the pool one strategy controls. It answers "no
single strategy may control most of the pool", which is a real control and _is_ sensitive to
reassignment. It is available alongside pool concentration and is never a substitute for it.

### 1b. Prospective worst-case exposure

Admission evaluates the **post-plan** state, not the current one: a plan within the limit
today and over it the moment it fills has not respected the limit. Worst case means maximum
acquisition of the target asset and maximum spend from the funding asset, since that
maximises the ratio. Fees are naturally handled — acquiring less than is spent shrinks the
pool total, which the calculation reflects.

### 1c. Zero denominators

An empty pool yields `EMPTY_POOL` rather than a division by zero, and blocks a risk increase
because the current-state ratio is undefined. A first purchase into an empty pool is still
evaluated, because the prospective denominator is non-zero.

### 2. Unpriceable assets fail closed

If any asset in the denominator has no reference price inside its freshness class,
concentration is `UNCOMPUTABLE` and every risk-increasing action is blocked with
`POLICY_CONCENTRATION_UNCOMPUTABLE`. It is never treated as zero, and never skipped.

### 3. Freshness classes

| Class              | Applies to                       | Behaviour when exceeded                  |
| ------------------ | -------------------------------- | ---------------------------------------- |
| `PRICE_SNAPSHOT`   | reference prices for valuation   | concentration UNCOMPUTABLE               |
| `ACCOUNT_SNAPSHOT` | balances backing capacity checks | dispatch blocked, `EVIDENCE_STALE`       |
| `SYMBOL_METADATA`  | filters, lot and tick sizes      | planning blocked                         |
| `VENUE_CLOCK`      | measured venue clock offset      | dispatch blocked, `CLOCK_SKEW_UNBOUNDED` |

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

The exact counterexample above — 600 of a 1000 pool split three ways against a 50% limit —
asserted to be EXCEEDED, and asserted identical to the same 600 held by one strategy.
Invariance across five different partitions of the same holding. Exact rational boundaries at
the limit and one atom over, a repeating rational, and values beyond IEEE754 exact integers.
Zero denominators, HOUSE-only pools, an unpriceable asset that must be UNCOMPUTABLE rather
than treated as worthless, prospective exposure passing on the current state and failing on
the post-plan state, and a plan refused for spending more than the pool holds. A missing
freshness configuration refusing startup.
