# Module handoffs

The session header asks each module to record its handoff at `docs/handoffs/<module>.md`.

M0 delivered modules 00, 01 and 02 together with the shell foundation of 21, and its evidence
is one record rather than four near-copies: [00-foundation.md](00-foundation.md). The
per-module files below exist at the promised paths and point there, so a later module reading
`docs/handoffs/02.md` for a dependency finds what it needs.

| Module                    | Handoff                                               | Status                                     |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| 00 — integration gate     | [00.md](00.md) → [00-foundation.md](00-foundation.md) | PARTIAL — venue capability BLOCKED         |
| 01 — workspace foundation | [01.md](01.md) → [00-foundation.md](00-foundation.md) | COMPLETE                                   |
| 02 — money and contracts  | [02.md](02.md) → [00-foundation.md](00-foundation.md) | COMPLETE                                   |
| 21 — UI foundation        | shell only, in [00-foundation.md](00-foundation.md)   | PARTIAL — SDK wiring deferred to module 19 |
