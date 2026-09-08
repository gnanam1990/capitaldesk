# CapitalDesk project status

The single authoritative record of what is built, what is proven and what is blocked.
Updated with every milestone. Where a claim is not backed by a command in this document, it
is not a claim.

- **Milestone:** M7 — governed execution, operations, console and release gates (modules 11–29).
- **Branch:** `main`.
- **Pull request:** [#8](https://github.com/gnanam1990/capitaldesk/pull/8), merged at
  `c491942e8244d7bbe625670726fd3c72fa3b0a91` from exact tested head
  `bc1d51a854fa480e9c02400454748fea556074a9`.
- **Previous milestones:** M0 merged as
  [#1](https://github.com/gnanam1990/capitaldesk/pull/1); M1 merged as
  [#2](https://github.com/gnanam1990/capitaldesk/pull/2) at `f2f4d59`; M2 merged as
  [#3](https://github.com/gnanam1990/capitaldesk/pull/3) at `21935cc`, from reviewed head
  `013f733` whose final totals were 717 unit, 13 property and 334 integration.
- **Modules 08–10:** merged through
  [#7](https://github.com/gnanam1990/capitaldesk/pull/7) at `cb93a2d`.
- **Module 03:** complete — see [docs/handoffs/03.md](handoffs/03.md).
- **Module 04:** complete — see [docs/handoffs/04.md](handoffs/04.md).
- **Module 05:** PARTIAL — deterministic and real-PostgreSQL paths complete; the authenticated
  venue boundary is BLOCKED on a missing credential. See [docs/handoffs/05.md](handoffs/05.md).
- **Module 06:** PARTIAL — the baseline, the claim model and owner allocations are complete and
  proven; T-014 and the full T-012 sweep need module 14. See
  [docs/handoffs/06.md](handoffs/06.md).
- **Module 07:** PARTIAL — all owned target acceptance and lifecycle paths are complete;
  planner-owned T-004/T-005 and the generated-child portion of T-010 need module 09. See
  [docs/handoffs/07.md](handoffs/07.md).
- **Module 08:** complete for owned paths — owner mandate, immutable policy journal and
  budget-hold paths are implemented and focused PostgreSQL tests pass. See
  [docs/handoffs/08.md](handoffs/08.md).
- **Module 09:** complete for the v1 pure preview path — see [docs/handoffs/09.md](handoffs/09.md).
- **Module 10:** complete for the v1 sealing transaction — see [docs/handoffs/10.md](handoffs/10.md).
- **Module 11:** PARTIAL — local owner approvals and immutable evidence complete; native
  approved-host evidence is unavailable. See [docs/handoffs/11.md](handoffs/11.md).
- **Module 12:** PARTIAL — isolated local/testnet signer boundary complete; production topology
  proof is unavailable. See [docs/handoffs/12.md](handoffs/12.md).
- **Module 13:** complete for the local journal/simulator boundary — see
  [docs/handoffs/13.md](handoffs/13.md).
- **Modules 14–16:** PARTIAL — exact allocation, finality, UNKNOWN handling and drift recovery
  are implemented; authenticated venue evidence is unavailable. See
  [docs/handoffs/14.md](handoffs/14.md), [15.md](handoffs/15.md), and
  [16.md](handoffs/16.md).
- **Modules 21–24:** PARTIAL — responsive owner operations views and state contracts are
  implemented; live SDK/SSE mutations are pending modules 17–20. See
  [docs/handoffs/21.md](handoffs/21.md) through [24.md](handoffs/24.md).
- **Modules 17–20:** PARTIAL — operational API/OpenAPI, durable jobs/events, SDK/CLI and
  proposal-only agent tools are implemented; continuous external delivery and authenticated
  host invocation remain unavailable. See [docs/handoffs/17.md](handoffs/17.md) through
  [20.md](handoffs/20.md).
- **Modules 25–27:** PARTIAL — deterministic fault lab, security/observability controls and
  deployment/restore contracts are implemented; infrastructure and real-venue drills remain
  unavailable. See [docs/handoffs/25.md](handoffs/25.md) through [27.md](handoffs/27.md).
- **Module 28:** release proof tooling and operator package implemented; real testnet evidence
  blocked. See [docs/handoffs/28.md](handoffs/28.md).
- **Module 29:** BLOCKED by the finite real-boundary evidence list; the acceptance gate fails
  closed. See [docs/handoffs/29.md](handoffs/29.md).

## What this milestone is, and is not

M0 resolved the ten reviewed contract findings and built the executable foundation. M1 adds
the authority model underneath the economic core: who the owner is, what an agent may propose,
and the scope every object lookup is bound by.

M3 adds the economic core's first half: an opening position bound to one authenticated account
and one epoch, and a per-asset claim model in which every governed unit has exactly one
explicit owner. Opening inventory belongs to HOUSE until the owner allocates it, and an
allocation moves an internal claim between HOUSE and one strategy — never between strategies,
and never anything at the venue.

M2 added the read boundary it consumes: narrow, origin-bound, credential-class-restricted
readers, durable per-symbol trade cursors, and the worker catch-up that assembles a bracketed
observation cut and asks the shared coverage predicate for a verdict.

The repository now contains the deterministic planner, atomic seal, immutable owner approval,
approval-bound isolated signer, one-shot durable dispatcher, exact fill allocator,
reconciliation/recovery services and responsive owner console. Production writes remain
disabled. The read boundary still cannot express a write, and the executor cannot produce an
order without exact sealed-plan authority and a current approval.

**Five public, non-economic reads** of `testnet.binance.vision` were performed and are recorded
in [docs/evidence/binance-read-capability.md](evidence/binance-read-capability.md). No
authenticated endpoint has ever been called: no `VENUE_READ` credential is configured, so
account balances, order lookup, the open-order scan and trade history are proven against
fixtures built from the documented shapes and **not** against a real account. That boundary is
BLOCKED and is named as such rather than claimed.

## Status by area

| Area                                     | Status                           | Evidence                                                                        |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| Reviewed findings F1-F10                 | Resolved in ADRs, specs amended  | `docs/adr/`, `specs/capitaldesk/AMENDMENTS.md`                                  |
| Money, identity, state, digest contracts | Implemented                      | `packages/contracts`, 230 unit + 13 property tests                              |
| Environment contracts, fail-closed       | Implemented                      | `packages/config`, 28 cases                                                     |
| Redacted logging                         | Implemented                      | `packages/observability`, 8 cases                                               |
| Migration lifecycle                      | Implemented                      | `packages/db`, 22 integration cases on real PostgreSQL                          |
| Dependency and credential boundaries     | Enforced by command              | `tools/`, 8 cases, verified to fail on real violations                          |
| Binance read boundary (module 05)        | Implemented; venue auth BLOCKED  | `packages/binance`, 204 unit cases; `docs/evidence/binance-read-capability.md`  |
| Read cursors, snapshots and cuts         | Implemented                      | `packages/db` migration 0004, 42 integration cases on real PostgreSQL           |
| Worker ingest catch-up                   | Implemented                      | `apps/worker`, 31 integration cases on real PostgreSQL                          |
| Baseline and claim ledger (module 06)    | Implemented                      | `packages/ledger` 61 unit + 6 property; migration 0005, 65 integration cases    |
| Strategy targets (module 07)             | Implemented                      | 10 unit, 12 real-PostgreSQL route/repository cases; migration 0006              |
| Capital mandates (module 08)             | Implemented                      | 11 unit cases; 5 policy PostgreSQL cases plus intent regression suite           |
| Deterministic planner (module 09)        | Implemented                      | `packages/planner`; 8 focused unit cases                                        |
| Atomic plan sealing (module 10)          | Implemented                      | migration 0008; 3 focused real-PostgreSQL cases                                 |
| Owner approval journal (module 11)       | Implemented; host proof blocked  | migration 0009; 10 focused PostgreSQL cases                                     |
| Durable dispatch (modules 12–13)         | Implemented for local/testnet    | `apps/executor`; 15 focused cases plus journal integration                      |
| Fills and reconciliation (modules 14–16) | Implemented; venue proof blocked | `packages/reconciler`, `packages/ledger`; unit and PostgreSQL evidence          |
| Truthful health                          | Implemented                      | `apps/api`, 5 unit + 4 integration cases                                        |
| Worker and executor processes            | Boundaries implemented           | `apps/worker`, `apps/executor`                                                  |
| Owner operations console                 | Implemented, browser-verified    | `apps/web`, 11 routes and 73 focused cases                                      |
| API, SDK, CLI and agent tools (17–20)    | Implemented; delivery partial    | 20 focused unit + 6 PostgreSQL cases on the module branch                       |
| Fault/security/deployment (25–27)        | Implemented; infra proof partial | 61 focused and 851 full unit cases on the module branch                         |
| Release evidence (28–29)                 | Tooling complete; gate blocked   | exact-head proof manifest tests; honest failing release gate                    |
| Identity, sessions, agent credentials    | Implemented (module 03)          | `packages/domain`, `apps/api/src/auth`, 60 unit + 88 integration cases          |
| Same-origin console routing              | Implemented, proxy verified      | `apps/web/src/app/api-routing.ts`, 6 unit cases                                 |
| Transactional journal (module 04)        | Implemented (module 04)          | `packages/db/src/journal`, 46 integration cases on real PostgreSQL              |
| CI                                       | Fresh checkout + real PostgreSQL | `.github/workflows/ci.yml`                                                      |
| Economic core                            | Implemented through recovery     | Baseline, claims, intents, plans, approvals, dispatch, fills and reconciliation |
| Venue integration                        | **Blocked**, see below           | —                                                                               |

## Commands and results at this branch

Pull request #8's required GitHub CI ran on exact head `bc1d51a` before merge. Both the fresh
checkout job and the real PostgreSQL job passed.

```sh
pnpm install --frozen-lockfile
pnpm run verify
CAPITALDESK_TEST_DATABASE_URL=postgres://localhost:5432/capitaldesk_test pnpm run test:integration
```

| Command                                       | Result                                                      |
| --------------------------------------------- | ----------------------------------------------------------- |
| `pnpm run format:check`                       | pass                                                        |
| `pnpm run typecheck`                          | pass                                                        |
| `pnpm run lint`                               | pass                                                        |
| `pnpm run check:layering`                     | pass — 16 packages, 136 crossings checked                   |
| `pnpm run check:secrets`                      | pass — 436 files scanned                                    |
| `pnpm run test:unit`                          | **905 passed**, 0 skipped, 72 files                         |
| `pnpm run test:property`                      | **19 passed**, seed 20260908                                |
| `pnpm run test:integration`                   | **447 passed**, 0 skipped, against real PostgreSQL          |
| `pnpm run test:integration` (no database URL) | **refused**, exit 1 — the gate no longer passes by skipping |
| `pnpm run build`                              | pass — all packages and apps                                |

Module 08 targeted results:

| Command                             | Result                              |
| ----------------------------------- | ----------------------------------- |
| `pnpm typecheck`                    | pass                                |
| mandate unit file                   | 11 passed                           |
| policy and intent integration files | 15 passed on local PostgreSQL 17.10 |

Modules 09–10 targeted results:

| Command                  | Result                             |
| ------------------------ | ---------------------------------- |
| planner unit file        | 8 passed                           |
| sealing integration file | 3 passed on local PostgreSQL 17.10 |

Modules 11–24 accelerated results:

| Command / area                         | Result                                             |
| -------------------------------------- | -------------------------------------------------- |
| repository typecheck                   | pass                                               |
| executor + allocation + reconciliation | 26 focused tests passed                            |
| owner approval                         | 10 focused PostgreSQL tests passed                 |
| reconciliation                         | 4 new + 5 existing focused PostgreSQL tests passed |
| owner console                          | 73 focused tests and Next production build passed  |

Integrated modules 17–29 accelerated results:

| Command / area                   | Result                                              |
| -------------------------------- | --------------------------------------------------- |
| repository typecheck             | pass                                                |
| new platform/fault/release tests | 51 focused tests passed on the integrated branch    |
| dispatch + non-send PostgreSQL   | 18 focused integration tests passed after CI repair |

The three test numbers are **workspace totals**, not per-area figures. Final exact-head totals:

| Suite       | Count | Where                                                                 |
| ----------- | ----- | --------------------------------------------------------------------- |
| unit        | 905   | 72 files in the fresh-checkout CI report                              |
| property    | 19    | contracts and ledger generated cases                                  |
| integration | 447   | real PostgreSQL CI report; 131 test-file entries, 0 failed or skipped |

No area's evidence is the workspace total. Module 03's own evidence is the 60 unit and 91
integration cases listed in [docs/handoffs/03.md](handoffs/03.md), module 04's the 119
integration cases in [docs/handoffs/04.md](handoffs/04.md), and module 05's the 204 unit and 73
integration cases in [docs/handoffs/05.md](handoffs/05.md) — not the workspace figures.

Toolchain: Node 22.23.1, pnpm 11.10.0, TypeScript 5.9.3, Fastify 5.12.3, Next 16.3.4,
React 19.2.8, Vitest 4.1.11, zod 4.5.4, PostgreSQL 17.10 (Homebrew, local).

## Blockers

| Blocker                                                              | Effect                                                                                                                                               | What would clear it                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| No authenticated Binance testnet credential is configured            | No integration proof of any kind. Account identity, symbol filters, commission rates, IOC behaviour and order correlation are all unverified.        | The user configures an authorized Spot Testnet credential for the executor and reader roles. |
| No venue-evidenced pre-trade fee bound                               | The local exact allocator exists, but production dispatch cannot use an unverified commission bound.                                                 | Authenticated venue evidence establishes the exact fee inputs and bound.                     |
| No producer of a movement-universe proof or gap recovery certificate | Coverage cannot reach COMPLETE against a real account, so governed dispatch is unavailable (ADR-0002).                                               | Module 05, against a real account, with concrete cursor and retention evidence.              |
| Competition eligibility                                              | Unverified. Not pursued by this build.                                                                                                               | Separate, explicitly authorized decision.                                                    |
| No authenticated read has ever been performed                        | Account balances, order lookup, the open-order scan and trade history are proven only against fixtures. Reader/trader identity equality is unproven. | The user configures a `VENUE_READ` credential for the authorized account.                    |
| No live non-send evidence                                            | The fenced `NOT_SENT_PROVEN` path exists, but no production observation has satisfied it.                                                            | A real fenced sender plus complete open-order/trade coverage supplies the evidence.          |

None of these blocks the local product implementation. They block **claims of funded/live
venue proof**, which is why the release gate reports execution evidence as unavailable.

## Next action

Supply separately scoped `VENUE_READ` and `VENUE_TRADE` testnet credential references, then
run the bounded pilot and create an exact-head release manifest. Until authenticated account,
IOC/fill/fee, response-loss and browser artifacts exist, the final release decision remains
blocked even though the implemented project and CI are green.
