# ADR-0010 — One initially supported fee policy, gated on a proven bound

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F10 (Medium)
- Amends: TDD section 6; TEST-PLAN sections 4 and 11; prompts 00, 14

## Context

The review accepts the controlled-rounding approach and is precise about what the evidence
does _not_ cover: an independently enumerated 5x2 oracle for T-055 supports the chosen
method, but does not prove the general circulation construction, arbitrary combined fee
subcaps, or every permitted exchange fill partition.

It also names a concrete hazard. Binance documents BNB commission falling back to the
received asset when the BNB balance is insufficient, so a BNB-only reservation assumption can
be incomplete: the debited asset can change mid-order.

The hard boundary is already acknowledged in the pack: an observed _rate_ does not establish
a conservative cumulative _debit bound_ across all partial fills with native rounding.

## Decision

### 1. A fee policy is a capability, and today none of them authorizes a real dispatch

Every policy carries a `boundStatus` of `PROVEN`, `UNVERIFIED` or `REFUTED`. `REFUTED` means
a bound was sought and shown not to exist — a demonstrated impossibility. No policy carries
it, because we have no such proof for any of them; claiming one would be as inaccurate as
claiming a bound we do not have. Only `PROVEN`
may dispatch, and even then the gate additionally requires a `FeeBoundEvidence` record
supplied at call time: the derivation's maximum fill count, the evidenced minimum fill size
that makes that count finite, and a digest of the derivation. A policy constant can therefore
never authorize dispatch on its own — flipping a status to `PROVEN` without producing a
derivation still refuses.

### 2. `STANDARD_NO_BNB_V1` is UNVERIFIED, not proven

An earlier version of this decision declared it proven, reasoning that the cumulative bound
is the sum of per-fill ceilings. Maintainer review was right to reject that: summing per-fill
ceilings describes the **realized** fee once the fills are known. It is not an a-priori
bound, because nothing there bounds the _number_ of fills. A conservative pre-trade bound
needs an evidenced minimum fill size and a supported partition granularity, and deriving
those is module 14's work against real venue evidence.

Until that derivation exists, this policy refuses dispatch. What is settled about it:

- Commission is taken in the **received asset** — base on a BUY, quote on a SELL — at the
  verified per-symbol rate, matching Binance's standard schedule.
- The per-fill ceiling is `ceil(rate x fillQuantity)` in that asset.
- It requires the account's BNB fee payment to be **verified disabled**. If that setting
  cannot be read, any observed BNB commission quarantines rather than being absorbed.
- A fully filled BUY leaves net base below target by the base commission, and no second order
  is created automatically. The UI must state this.

### 2a. `QUOTE_FEE_FIXTURE_V1` is PROVEN only because the fixture fixes the partition

The deterministic scenario states exactly which fills occur, so the fill count is known
rather than bounded. That is precisely why the policy is refused outside `local`.

### 3. `BNB_DISCOUNT_UNPROVEN` is defined, disabled and UNVERIFIED

Defined so the code can name and refuse it. Its documented insufficiency fallback lets the
debited asset change mid-order, and no pre-trade bound has been derived for that.

It is `UNVERIFIED`, not `REFUTED`. We have an absent derivation, not a proof that no bound
exists — a bound may well exist once the fallback condition is itself bounded. Enabling it
later requires deriving that bound, not relaxing this decision.

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

`STANDARD_NO_BNB_V1` refusing dispatch even with evidence supplied; a `PROVEN` policy
refusing when no derivation is supplied, when the derivation names a different policy, when
the fill count is not a finite positive integer, or when the minimum fill size is not
positive; BNB routing refused regardless of evidence, and its status asserted to be UNVERIFIED with a
rationale that does not claim impossibility; the fixture policy refused outside
`local`; and an assertion that no shipped policy can authorize a real dispatch today. Then
the accounting scenarios: fee charged in quote, base and BNB; unsupported or unowned fee
asset; a fee above the approved bound; fee-asset change within one child order; infeasible
combined caps. Extends T-016, T-017, T-018, T-055, T-057, T-058; new scenario T-070.
