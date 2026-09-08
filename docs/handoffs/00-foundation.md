# Handoff — M0 foundation (prompts 00, 01, 02, plus the shell foundation of 21)

**Status: PARTIAL.** Every deliverable owned by this milestone is complete and verified.
Venue integration is BLOCKED, and nothing in this milestone claims otherwise.

- **Tested head:** `200e8fc75db5b71571ac947ab5c8847654b176a0`
- **Pull request:** [#1](https://github.com/gnanam1990/capitaldesk/pull/1)
- **Covers modules:** 00, 01, 02, and the shell foundation of 21. The per-module handoffs
  [00](00.md), [01](01.md) and [02](02.md) point here rather than repeating this record.

## What was built

| Path                       | What it is                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`       | Money atoms, prices, marked value, identities, state machines, reason codes, canonical encoding, approval digest, timing envelope, fee capability, coverage predicate, risk arithmetic, lifecycle table |
| `packages/config`          | Validated fail-closed environment contracts and the credential-class boundary                                                                                                                           |
| `packages/observability`   | Redaction by key name and value shape, structured logging                                                                                                                                               |
| `packages/db`              | Forward-only migration runner with read-only status and history divergence detection                                                                                                                    |
| `apps/api`                 | Fastify process, truthful liveness and readiness, no `/v1` surface                                                                                                                                      |
| `apps/worker`              | Starts, asserts its credential class, idles; no ingest loop exists                                                                                                                                      |
| `apps/executor`            | Starts, asserts its credential class, idles; no dispatch path exists                                                                                                                                    |
| `apps/web`                 | Console shell, design tokens, one Overview page consuming the real API                                                                                                                                  |
| `tools/`                   | Dependency-layering and credential-boundary checkers                                                                                                                                                    |
| `docs/adr/`                | Eleven decision records resolving F1-F10 plus the visual direction                                                                                                                                      |
| `.github/workflows/ci.yml` | Fresh-checkout verification and a real-PostgreSQL integration job                                                                                                                                       |

## Provenance of the specification pack

The reviewed pack was imported byte-for-byte from the supplied original and verified against
the SHA-256 inventory in `docs/maintainer/capitaldesk-spec-inventory.json` before any change
was made. That verification was performed against the **pre-cleanup** import.

The repository history was subsequently rewritten by the maintainer to remove attribution
material, which rewrote every commit including the baseline. Current baseline bytes are
therefore the sanitized form, not the original bytes, and the inventory hashes will not match
the current tree for files the sanitization touched. The original bytes are preserved outside
this repository in the pre-cleanup bundle and the original archive, with a commit mapping
held alongside them. Provenance claims in this repository should be read against that bundle,
not against the current baseline commit.

22 of 39 specification files were then amended under ADRs, each marked inline.

## Evidence

Commands run at this head, on a clean tree:

```
pnpm install --frozen-lockfile        pass
pnpm run format:check                 pass
pnpm run typecheck                    pass
pnpm run lint                         pass (from a cold tree)
pnpm run check:layering               pass — 8 packages, 26 crossings
pnpm run check:secrets                pass — 153 files scanned
pnpm run test:unit                    231 passed, 0 skipped, 15 files
pnpm run test:property                 13 passed, seed 20260908
pnpm run test:integration              22 passed (PostgreSQL 17.10)
pnpm run test:integration (no db)      22 skipped — reported as skipped, never as coverage
                                       (superseded: the gate now refuses to start with no
                                        database URL; see docs/handoffs/04.md)
pnpm run build                        pass
```

Those are **workspace totals**. Scoped by area, so no module claims evidence it does not have:

| Area                     | unit               | property | integration |
| ------------------------ | ------------------ | -------- | ----------- |
| `packages/contracts`     | 186 across 9 files | 13       | —           |
| `packages/config`        | 20                 | —        | —           |
| `packages/observability` | 8                  | —        | —           |
| `packages/db`            | —                  | —        | 18          |
| `apps/api`               | 5                  | —        | 4           |
| `apps/web`               | 17                 | —        | —           |
| `tools`                  | 8                  | —        | —           |
| **total**                | **231**            | **13**   | **22**      |

CI at this head: both jobs green — `Verify (fresh checkout)` and
`Integration (real PostgreSQL)`.

### Evidence classes, kept apart

- **Unit** — deterministic reference models over pure functions.
- **Property** — generated cases at a recorded seed, with independent oracles where the
  property is arithmetic.
- **Integration** — a real PostgreSQL server and the real Fastify instance. Skips visibly
  when no database is configured; CI fails if it skips.
- **Browser** — Playwright against the running console and API.
- **Venue** — none. No Binance account has been contacted.

### Browser verification

Widths 375, 768, 1024 and 1440: no page-level horizontal overflow (`scrollWidth` equals
`clientWidth` at each). Nine text pairs and four status pills measured with inherited opacity
applied, all at or above 4.5:1, lowest 5.28:1. Skip link present, `lang="en"`, one `h1`,
disabled destinations marked `aria-disabled` with a stated reason. Screenshots of the
connected and degraded states are in `artifacts/proofs/m0-foundation/ui/`.

### Checkers verified to fail, not merely to pass

A check that cannot fail proves nothing, so each was verified against an injected violation:

| Injected violation                                      | Result                                     |
| ------------------------------------------------------- | ------------------------------------------ |
| `web -> db` manifest dependency                         | exit 1, forbidden edge named               |
| Relative re-export from `apps/api` into `apps/executor` | exit 1, forbidden edge named               |
| Path into `apps/executor/dist`                          | exit 1, forbidden edge named               |
| 64-character mixed-case key literal in a source file    | exit 1, file and line named                |
| The same literal in a test file                         | exit 1 — the scan is not relaxed for tests |
| A real key value in `.env.example`                      | exit 1                                     |
| `opacity` reintroduced on a text-bearing rule           | test fails                                 |
| Integration suite with no database                      | CI guard fails                             |

## Defects found and fixed during this milestone

All were found by independent review or by verification, not by inspection of the code alone.

| Defect                                                                                                         | Fix                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Sparse arrays encoded to the same digest as an empty array; `new Array(2)` emitted invalid JSON                | Array holes refused                                                                            |
| An unknown decision-changing field left the approval digest unchanged                                          | Strict frozen-field validation at every level an approval binds                                |
| Negative accounting scales accepted; conversions could exceed the money precision bound                        | Scales bound to 0-30; result magnitude enforced; oversized atom strings refused before parsing |
| The timing envelope bound the local cutoff to the approval deadline, leaving a window of twice the skew budget | Bound the worst-case venue acceptance cutoff instead; clock domains named                      |
| Layering checker saw only package specifiers, so a relative re-export across the executor boundary passed      | Every import resolved to its owning package by path                                            |
| The owner could not halt their own pool                                                                        | Per-action actor allowlists                                                                    |
| Sealed-plan effect after the marker was contradictory in code and comment                                      | Resolved effect: future authority only, never a claimed cancellation                           |
| Pool concentration could be defeated by splitting a holding across strategies                                  | Exposure summed across every owner, HOUSE included                                             |
| Coverage reported COMPLETE for a window containing an undetected external round trip                           | Predicate turns on proving the movement universe; transport continuity is not proof            |
| `migrationStatus` wrote to the database                                                                        | Read-only status, wrapped in `BEGIN READ ONLY`                                                 |
| A divergent applied history was accepted silently                                                              | Applied history must be an exact prefix; four divergence kinds refuse                          |
| A hardcoded flag declared the fee bound proven                                                                 | Evidence-gated capability; no shipped policy can dispatch today                                |
| Lint failed on a clean checkout and passed once warm                                                           | `lint` builds declarations first                                                               |
| Console overflowed the page at 375px                                                                           | Grid track constrained; only a labelled region scrolls                                         |
| Navigation text rendered at 3.19:1 effective contrast                                                          | Opacity removed; guarded by a test                                                             |

## Blockers

1. **No authenticated Binance testnet credential.** No integration proof exists. Account
   identity, symbol filters, commission rates, IOC behaviour and order correlation are
   unverified. Clearing this needs the user to configure an authorized credential.
2. **No pre-trade fee bound.** Every shipped fee policy refuses dispatch (ADR-0010).
3. **No producer of a movement-universe proof or gap recovery certificate.** Coverage cannot
   reach COMPLETE against a real account (ADR-0002). Module 05 owns this.

The coverage and fee tests exercise the **gates' truth tables**, not producers of the
evidence those gates consume. A green run is not venue coverage.

## Ready next

Prompt 03 (identity and access) and prompt 04 (transactional journal) are unblocked and
depend only on what this milestone froze. Prompt 05 is unblocked for interface work but its
proof producers are blocked on a credential.
