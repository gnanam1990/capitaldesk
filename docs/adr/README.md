# Architecture decision records

Each ADR resolves a specific gap in the reviewed specification pack. The originals are
preserved untouched in git history at commit `c68137e`; every change since is an explicit,
dated decision recorded here and applied coherently to `specs/capitaldesk/`.

| ADR | Finding | Decision |
|---|---|---|
| [0001](0001-unresolved-dispatch-liveness.md) | F1 | Unresolved dispatch gains a provable recovery exit and an honest terminal state |
| [0002](0002-account-observation-coverage.md) | F2 | An executable five-condition coverage predicate, and a narrowed guarantee |
| [0003](0003-submission-deadline-and-signing.md) | F3 | The signed-request timing envelope and the linearization boundary |
| [0004](0004-venue-observation-schema.md) | F4 | Self-trade prevention statuses, and unknown observations preserved not guessed |
| [0005](0005-authorization-durability.md) | F5 | Durability class for authorization records; unrecoverable attribution named |
| [0006](0006-owner-lifecycle-contracts.md) | F6 | The owner lifecycle action table, deferral scope and post-marker effects |
| [0007](0007-credential-classes.md) | F7 | Three separate credential classes bound to process roles |
| [0008](0008-intent-cohort-and-closure.md) | F8 | When the candidate set closes, and how late opposing intent is handled |
| [0009](0009-risk-policy-arithmetic.md) | F9 | Exact concentration, freshness, time source and fail-closed defaults |
| [0010](0010-fee-policy-capability.md) | F10 | One initially supported fee policy, gated on a proven cumulative bound |
| [0011](0011-visual-direction.md) | — | The visual direction amendment to UI-UX.md |

## What an ADR here may and may not do

An ADR resolves an ambiguity, narrows an over-broad claim, or adds a missing contract. It
may not weaken an invariant to make implementation easier. Where the honest resolution is
that a guarantee cannot be provided, the ADR says so and narrows the promise instead of
leaving the stronger claim in place.
