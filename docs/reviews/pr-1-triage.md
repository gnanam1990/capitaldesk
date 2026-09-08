# PR 1 review triage

40 review candidates, each independently reproduced against the code before any decision.
Review text was treated as untrusted input: nothing was applied because it was suggested, and
nothing was rejected because it was inconvenient.

**Outcome: 40 addressed — 38 confirmed and fixed, 2 confirmed and deliberately scoped.** No
candidate was rejected as invalid. Two probes of my own were wrong and are recorded as such.

## How to read this

| Column     | Meaning                                              |
| ---------- | ---------------------------------------------------- |
| Reproduced | What I observed running the code, before changing it |
| Resolution | What changed, or why it did not                      |
| Proof      | The committed test that fails without the fix        |

Commits: `085a4b5` process lifetime, `ab5b709` logging, `a2232f2` tooling, `03b3078`
scanner tests, `a97cf03` contracts, `a6a5e72` database, `57d6404` config credentials,
`ccdd36b` API health probe, `dd9b689` console readiness, `134ae42` cap tables and the
coverage condition count, and this document.

## P1 — confirmed and fixed

| #   | ID         | Area                   | Reproduced                                                              | Resolution                                                                             | Proof                                            |
| --- | ---------- | ---------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 2   | 3954485579 | worker lifetime        | exit 13 in ~0.1s, "unsettled top-level await"                           | Referenced keep-alive handle; clean shutdown                                           | `apps/worker/src/lifetime.integration.test.ts`   |
| 24  | 3954485754 | executor lifetime      | Same                                                                    | Same                                                                                   | `apps/executor/src/lifetime.integration.test.ts` |
| 10  | 3954485655 | Pino redaction         | Message, interpolation, child and base bindings all leaked              | Three layers: logMethod hook, formatters plus wrapped `child()`, scrubbing destination | `packages/observability/src/logger.test.ts`      |
| 7   | 3954485636 | URL aliases            | `access_token`, `refreshToken`, `client_secret`, `api-key` all survived | Parameter names matched by sensitive fragment                                          | Same file                                        |
| 4   | 3954485614 | scanner exemption      | Key under `docs/` accepted, exit 0                                      | Documentation carve-out removed                                                        | `tools/check-secret-boundary.test.ts`            |
| 5   | 3954485623 | import parser          | Side-effect import swallowed by the `from` matcher                      | Replaced regex with the TypeScript AST                                                 | `tools/check-layering.test.ts`                   |
| 14  | 3954485684 | scanner self-exclusion | Key in the scanner's own source accepted                                | Self-exclusion removed                                                                 | `tools/check-secret-boundary.test.ts`            |
| 15  | 3954485692 | prefix bounding        | `apps/executor-evil/` inherited the allowlist                           | Component-bounded prefixes                                                             | Same file                                        |
| 20  | 3954485725 | file coverage          | `.pem` and `Dockerfile` never read                                      | Reads every non-binary file, from `git ls-files`                                       | Same file                                        |
| 1   | 3954485575 | coverage certificate   | Certificate for the year 2020 satisfied a 2026 window; COMPLETE         | Certificate must cover the actual gap                                                  | `packages/contracts/src/observation.test.ts`     |
| 3   | 3954485609 | fee evidence           | `derivedAt: "not-a-date"` and empty digest accepted                     | Both validated; strict UTC instant                                                     | `packages/contracts/src/fee-policy.test.ts`      |
| 8   | 3954485643 | account settings       | `requiredAccountSettings` never enforced                                | Verified settings passed in and checked                                                | Same file                                        |
| 9   | 3954485651 | lifecycle marker       | `MANUAL_REVIEW` assumed in flight                                       | Explicit dispatch phase, not a state inference                                         | `packages/contracts/src/lifecycle.test.ts`       |
| 11  | 3954485660 | credential identity    | Two empty ids compared equal                                            | Missing, whitespace and malformed ids refused                                          | `packages/contracts/src/credentials.test.ts`     |
| 13  | 3954485674 | release path           | `NOT_SENT_PROVEN` could never release                                   | Release contract takes the dispatch state                                              | `packages/contracts/src/states.test.ts`          |
| 6   | 3954485632 | write capability       | See scoped note below                                                   | Scoped, not fixed                                                                      | —                                                |
| 12  | 3954485670 | envelope capability    | See scoped note below                                                   | Partly fixed, remainder deferred                                                       | —                                                |

## P2 — confirmed and fixed

| #   | ID         | Reproduced                                                                             | Resolution                                                                                       | Proof                                            |
| --- | ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 16  | 3954485700 | `kind` overridable through the spread                                                  | `kind` assigned last                                                                             | `marked-value.test.ts`                           |
| 17  | 3954485705 | Terminal states returned INVALIDATE                                                    | Only an open sealed plan invalidates                                                             | `lifecycle.test.ts`                              |
| 18  | 3954485708 | 200k-char price parsed before bounds (24ms)                                            | Length checked first                                                                             | `price.test.ts`                                  |
| 19  | 3954485719 | Fixture route mislabelled as RECEIVED_ASSET while it charges quote commission on a BUY | Route is now `QUOTE_ALWAYS`, matching what it charges; still refused outside `local`             | `packages/contracts/src/fee-policy.test.ts`      |
| 21  | 3954485729 | Negative estimate and non-date accepted                                                | Validated                                                                                        | `marked-value.test.ts`                           |
| 22  | 3954485735 | Unreadable directory silently skipped                                                  | Only ENOENT ignored                                                                              | `check-layering.test.ts`                         |
| 23  | 3954485744 | `.js` sources unscanned                                                                | JS extensions included                                                                           | Same file                                        |
| 25  | 3954485761 | Timezone-less deadline resolved in host zone                                           | Strict UTC parser                                                                                | `time.test.ts`                                   |
| 26  | 3954485765 | Raw `BINANCE_*` accepted in the executor, its owning role                              | Raw value names split from reference names; refused in every role                                | `packages/config/src/env.test.ts`                |
| 27  | 3954485769 | Same-asset spend not netted (500 vs 400)                                               | Spend subtracted                                                                                 | `risk.test.ts`                                   |
| 28  | 3954485775 | `parseAtoms(1000)` returned `1000n`                                                    | Non-strings refused                                                                              | `money.test.ts`                                  |
| 29  | 3954485779 | `20000` and `20000.00` differed                                                        | Prices canonicalised                                                                             | `price.test.ts`                                  |
| 30  | 3954485791 | `venue: "made-up-venue"` accepted                                                      | Allowlists enforced at runtime                                                                   | `identity.test.ts`                               |
| 31  | 3954485797 | Only the connection had a timeout                                                      | Driver-level connection, query and statement timeouts, plus bounded teardown                     | `apps/api/src/server.integration.test.ts`        |
| 32  | 3954485803 | Two clients both applied one migration                                                 | Session advisory lock across the whole run                                                       | `migrator.integration.test.ts`                   |
| 33  | 3954485807 | Web config shown as API metadata                                                       | API report rendered when reachable; configuration labelled as such when not; mismatches surfaced | `apps/web/src/app/readiness.test.ts`             |
| 34  | 3954485810 | Malformed JSON threw during render                                                     | Payload validated against the contract, not merely its shape                                     | `apps/web/src/app/readiness.test.ts`             |
| 35  | 3954485819 | Trailing slash produced `//health/ready`                                               | Base URL normalised                                                                              | `apps/web/src/app/readiness.test.ts`             |
| 36  | 3954485824 | `2026-02-30` normalised into the digest                                                | Strict parser round-trips components                                                             | `time.test.ts`                                   |
| 37  | 3954485826 | Namesake table trusted                                                                 | Relation resolved by OID; invariants enforced                                                    | `migrator.integration.test.ts`                   |
| 38  | 3954485831 | ADR said six conditions, TDD and the index said five                                   | All three now state six, including the universe proof                                            | `specs/capitaldesk/TDD.md`, `docs/adr/README.md` |
| 39  | 3954485838 | Duplicate fee asset reordered the digest                                               | Duplicates refused; comparator made total                                                        | `packages/contracts/src/plan-digest.test.ts`     |
| 40  | 3954485849 | `new URL().pathname` breaks on Windows                                                 | `fileURLToPath`                                                                                  | `apps/web/src/app/tokens.test.ts`                |

## Confirmed, deliberately scoped

Two are real and deliberately not fully fixed. Fixing them would mean building module 12 or
13 functionality inside M0, which would be fabricating a runtime that does not exist.

I initially scoped a third, #26, on the grounds that refusing raw secrets needed a reference
resolver. That was wrong — separating raw value names from reference names needs no resolver —
and it is now fixed: `BINANCE_API_SECRET`, `BINANCE_SECRET_KEY` and `BINANCE_READ_API_SECRET`
are refused in every role including their owning one, and only the matching
`CAPITALDESK_*_CREDENTIAL_REF` is accepted, in its owning role alone.

**#6 — local may enable write capability.** Reproduced: `CAPITALDESK_ENV=local` with
`CAPITALDESK_WRITE_CAPABILITY=enabled` loads. The review asks that enabled writes be
testnet-only.

Restricted to `local` and `testnet`, with `production-read-only` still impossible. `local`
stays permitted because the fault lab and the local venue simulator need a configuration
that exercises the write path against `http://127.0.0.1:9443`, which the host allowlist
already confines. Removing it would leave module 25 unable to test dispatch at all without
loosening something more consequential. There is no dispatch path today in any case.

**#12 — the envelope is not a marker-bound capability.** Reproduced: any caller can construct
a `SignedRequestEnvelope`, and `assertEnvelopeWithinApproval` returns nothing that proves it
was checked.

The timing half is fixed — the envelope binds strict UTC instants, and the worst-case venue
acceptance cutoff is bound to the approved deadline. The capability half is not: minting an
opaque token at marker commit requires the marker, which is module 13. Building a mint with
nothing to mint from would be a stub presented as a boundary. Recorded in ADR-0003 as owed by
module 13.

## Where my own probes were wrong

Recorded because a triage that only lists the reviewer's errors is not a triage.

- **#5b, first attempt.** I reported a relative side-effect import as "still open". My probe
  used the wrong number of `../` for that directory depth, so it resolved inside the same
  package. Re-tested at the correct depth: detected.
- **#25, first attempt.** I recorded "NOT-REPRO" from a probe whose envelope expired long
  before the deadline, so the timezone difference could not surface. Isolating `Date.parse`
  confirmed a 19,800,000 ms difference on an IST host. Confirmed.

## Corrections to my own fixes, found in review

Five defects were introduced by these fixes and caught before merge. They are listed because
the fix rate matters less than whether the fixes were themselves checked.

| What I got wrong                                                                       | How it was caught                             |
| -------------------------------------------------------------------------------------- | --------------------------------------------- |
| `process.once` removed the handler, so a repeat signal killed cleanup mid-flight       | Probe with two SIGTERMs 150ms apart: exit 143 |
| Narrowed regex still missed three comment forms and rejected a commented-out import    | Fixture repositories against the real checker |
| Certificate required to cover the whole window, rejecting legitimate gap-only recovery | Review of the design, not the code            |
| `sealedPlanExists` stays true forever in an append-only system                         | Review of the model                           |
| `not.toBe` assertion passed while the required behaviour was still missing             | Review of the assertion strength              |

Two are worth remembering. A negative assertion proved only that the answer was not one
specific wrong value, while the code returned a different wrong value. And twice I reported a
fix from the patch I intended rather than the file that resulted — the edit had silently
failed to match. Verifying each edit landed is now part of the loop, not an afterthought.

The stalled-query regression was also checked against the old implementation: it hangs for
30 seconds and times out, rather than passing for an unrelated reason.
