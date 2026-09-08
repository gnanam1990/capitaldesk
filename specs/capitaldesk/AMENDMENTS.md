# Amendments to the reviewed specification

The specification pack in this directory was reviewed on 8 September 2026. The originals are
preserved untouched in git history at commit `c68137e`, and their SHA-256 inventory is in
`docs/maintainer/capitaldesk-spec-inventory.json`.

Every change since is recorded as an ADR in `docs/adr/` and applied to the affected documents
here. This file is the index; each amended section in the documents carries an inline
`> **Amended by ADR-NNNN.**` note pointing back to the decision.

| ADR | Finding | Documents amended |
|---|---|---|
| [ADR-0001](../../docs/adr/0001-unresolved-dispatch-liveness.md) | F1 | TDD 8, 9; TEST-PLAN 7, 11; prompts 13, 16 |
| [ADR-0002](../../docs/adr/0002-account-observation-coverage.md) | F2 | TDD 9; PRD 5, 7; TEST-PLAN 8; prompts 05, 15, 16 |
| [ADR-0003](../../docs/adr/0003-submission-deadline-and-signing.md) | F3 | TDD 9; PRD 8; TEST-PLAN 5; prompts 11, 12, 13 |
| [ADR-0004](../../docs/adr/0004-venue-observation-schema.md) | F4 | TDD 8; TEST-PLAN 7; prompts 02, 05, 15 |
| [ADR-0005](../../docs/adr/0005-authorization-durability.md) | F5 | TDD 10, 13; TEST-PLAN 7; prompt 27 |
| [ADR-0006](../../docs/adr/0006-owner-lifecycle-contracts.md) | F6 | TDD 11; UI-UX 5, 9; prompts 03, 07, 17, 23 |
| [ADR-0007](../../docs/adr/0007-credential-classes.md) | F7 | TDD 2, 3; prompts 01, 05, 12 |
| [ADR-0008](../../docs/adr/0008-intent-cohort-and-closure.md) | F8 | TDD 7; PRD 6; TEST-PLAN 5; prompts 09, 10, 11 |
| [ADR-0009](../../docs/adr/0009-risk-policy-arithmetic.md) | F9 | TDD 7; PRD 10; TEST-PLAN 6; prompt 08 |
| [ADR-0010](../../docs/adr/0010-fee-policy-capability.md) | F10 | TDD 6; TEST-PLAN 4, 11; prompts 00, 14 |
| [ADR-0011](../../docs/adr/0011-visual-direction.md) | — | UI-UX 2 |

## What changed in substance

Three amendments **narrow a promise** rather than adding a capability, and those are the ones
to read first:

- **ADR-0002** removes an implied account-wide external-trade *attribution* guarantee that the
  upstream API cannot support. Detection of any unexplained movement remains account-wide;
  attribution is bounded to the declared observed symbol set, and the owner operating
  constraint is now stated in the PRD.
- **ADR-0005** states plainly that some data-loss cases leave strategy attribution
  unrecoverable, and requires an explicit owner decision rather than a guessed FIFO order.
- **ADR-0010** disables BNB fee routing until its documented fallback is bounded, and records
  that the T-055 oracle supports the rounding method without proving the general solver.

No amendment weakens an invariant. Where the honest resolution was that a guarantee cannot be
provided, the promise was narrowed and the limitation written down.

## New test scenarios

The amendments add scenarios beyond the original 58. They extend rather than replace:

| ID | Scenario | ADR |
|---|---|---|
| T-059 | Post-marker crash with a fenced sender reaches NOT_SENT_PROVEN and releases | 0001 |
| T-060 | The same without a fence stays UNKNOWN and never releases | 0001 |
| T-061 | Coverage predicate: each of the five conditions failing in turn | 0002 |
| T-062 | Bracketing snapshots agreeing alone does not establish coverage | 0002 |
| T-063 | A paused transmitter cannot be accepted after the submission deadline, at every permitted clock offset | 0003 |
| T-064 | An unknown venue status quarantines instead of being mapped | 0004 |
| T-065 | Recovery from the authorization evidence bundle retains the original FIFO | 0005 |
| T-066 | Lifecycle action effects resolved at marked and unmarked plan states | 0006 |
| T-067 | Owner deferral survives a newer revision from the same strategy | 0006, 0008 |
| T-068 | Late opposing intent invalidates before the marker, queues after it | 0008 |
| T-069 | Concentration is UNCOMPUTABLE when any denominator asset is unpriceable | 0009 |
| T-070 | A fee policy without a proven cumulative bound refuses dispatch | 0010 |
