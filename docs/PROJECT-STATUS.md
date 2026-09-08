# CapitalDesk project status

The single authoritative record of what is built, what is proven and what is blocked.
Updated with every milestone. Where a claim is not backed by a command in this document, it
is not a claim.

- **Milestone:** M6 — deterministic planning and atomic reservation (modules 09–10).
- **Branch:** `feat/m6-planning-reservations`, stacked on module 08 pending its required merge.
- **Pull request:** pending after module 08 merges.
- **Previous milestones:** M0 merged as
  [#1](https://github.com/gnanam1990/capitaldesk/pull/1); M1 merged as
  [#2](https://github.com/gnanam1990/capitaldesk/pull/2) at `f2f4d59`; M2 merged as
  [#3](https://github.com/gnanam1990/capitaldesk/pull/3) at `21935cc`, from reviewed head
  `013f733` whose final totals were 717 unit, 13 property and 334 integration.
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

There is still **no planner, no approvals and no dispatch**, and no write adapter of any kind.
The read boundary cannot express a write — it has one verb, and it takes an endpoint name
rather than a URL. Module 06 moves internal claims only; nothing it does reaches a venue.

**Five public, non-economic reads** of `testnet.binance.vision` were performed and are recorded
in [docs/evidence/binance-read-capability.md](evidence/binance-read-capability.md). No
authenticated endpoint has ever been called: no `VENUE_READ` credential is configured, so
account balances, order lookup, the open-order scan and trade history are proven against
fixtures built from the documented shapes and **not** against a real account. That boundary is
BLOCKED and is named as such rather than claimed.

## Status by area

| Area                                     | Status                           | Evidence                                                                       |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| Reviewed findings F1-F10                 | Resolved in ADRs, specs amended  | `docs/adr/`, `specs/capitaldesk/AMENDMENTS.md`                                 |
| Money, identity, state, digest contracts | Implemented                      | `packages/contracts`, 230 unit + 13 property tests                             |
| Environment contracts, fail-closed       | Implemented                      | `packages/config`, 28 cases                                                    |
| Redacted logging                         | Implemented                      | `packages/observability`, 8 cases                                              |
| Migration lifecycle                      | Implemented                      | `packages/db`, 22 integration cases on real PostgreSQL                         |
| Dependency and credential boundaries     | Enforced by command              | `tools/`, 8 cases, verified to fail on real violations                         |
| Binance read boundary (module 05)        | Implemented; venue auth BLOCKED  | `packages/binance`, 204 unit cases; `docs/evidence/binance-read-capability.md` |
| Read cursors, snapshots and cuts         | Implemented                      | `packages/db` migration 0004, 42 integration cases on real PostgreSQL          |
| Worker ingest catch-up                   | Implemented                      | `apps/worker`, 31 integration cases on real PostgreSQL                         |
| Baseline and claim ledger (module 06)    | Implemented                      | `packages/ledger` 61 unit + 6 property; migration 0005, 65 integration cases   |
| Strategy targets (module 07)             | Implemented                      | 10 unit, 12 real-PostgreSQL route/repository cases; migration 0006             |
| Capital mandates (module 08)             | Implemented                      | 11 unit cases; 5 policy PostgreSQL cases plus intent regression suite          |
| Deterministic planner (module 09)        | Implemented                      | `packages/planner`; 8 focused unit cases                                       |
| Atomic plan sealing (module 10)          | Implemented                      | migration 0008; 3 focused real-PostgreSQL cases                                |
| Truthful health                          | Implemented                      | `apps/api`, 5 unit + 4 integration cases                                       |
| Worker and executor processes            | Start, assert boundary, idle     | `apps/worker`, `apps/executor`                                                 |
| Console shell and design tokens          | Implemented, browser-verified    | `apps/web`, 17 cases, screenshots in `artifacts/proofs/m0-foundation/ui/`      |
| Identity, sessions, agent credentials    | Implemented (module 03)          | `packages/domain`, `apps/api/src/auth`, 60 unit + 88 integration cases         |
| Same-origin console routing              | Implemented, proxy verified      | `apps/web/src/app/api-routing.ts`, 6 unit cases                                |
| Transactional journal (module 04)        | Implemented (module 04)          | `packages/db/src/journal`, 46 integration cases on real PostgreSQL             |
| CI                                       | Fresh checkout + real PostgreSQL | `.github/workflows/ci.yml`                                                     |
| Economic core (M1-M3)                    | In progress; module 06 complete  | Opening inventory, epoch claims and owner allocations                          |
| Venue integration                        | **Blocked**, see below           | —                                                                              |

## Commands and results at this branch

Module 08 is using the user's accelerated gate. The last full-workspace results below belong
to merged module 07. Module 08 adds the targeted results listed after them.

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
| `pnpm run check:layering`                     | pass — 11 packages, 89 crossings checked                    |
| `pnpm run check:secrets`                      | pass — 290 files scanned                                    |
| `pnpm run test:unit`                          | **788 passed**, 0 skipped, 44 files                         |
| `pnpm run test:property`                      | **19 passed**, seed 20260908                                |
| `pnpm run test:integration`                   | **417 passed**, 26 files, against PostgreSQL 17.10          |
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

The three test numbers are **workspace totals**, not per-area figures. The split by file:

| Suite       | Count | Where                                                                                                   |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------- |
| unit        | 788   | contracts 284, binance 204, web 65, ledger 61, tools 39, api 38, config 35, domain 39, observability 23 |
| property    | 19    | contracts 13 (`money.property.test.ts`), ledger 6 (`conservation.property.test.ts`)                     |
| integration | 417   | journal 236, auth 62, worker 37, migrations 36, CLI 20, identity scope 11, API 9, executor 6            |

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
| No pre-trade fee bound derived                                       | Every shipped fee policy refuses dispatch (ADR-0010).                                                                                                | Module 14 derives a bound with an evidenced minimum fill size and partition granularity.     |
| No producer of a movement-universe proof or gap recovery certificate | Coverage cannot reach COMPLETE against a real account, so governed dispatch is unavailable (ADR-0002).                                               | Module 05, against a real account, with concrete cursor and retention evidence.              |
| Competition eligibility                                              | Unverified. Not pursued by this build.                                                                                                               | Separate, explicitly authorized decision.                                                    |
| No authenticated read has ever been performed                        | Account balances, order lookup, the open-order scan and trade history are proven only against fixtures. Reader/trader identity equality is unproven. | The user configures a `VENUE_READ` credential for the authorized account.                    |
| `NOT_SENT_PROVEN` is unreachable                                     | A marked attempt that never sent cannot be resolved, so its reservation stays held. Conservative, and the only honest state for module 04.           | Module 15 records authoritative non-send evidence and adds the forward migration binding it. |

None of these blocks the independent implementation work in M1-M3. They block **claims of
proof**, which is why the code reports execution as unavailable rather than assuming it.

## Next action

Merge module 08 after its required CI, then open the modules 09–10 pull request. Module 11 can
add owner approval lifecycle on the immutable sealed payload. A live bootstrap still cannot
run because obtaining a COMPLETE observation cut needs the `VENUE_READ` credential that does
not exist.
