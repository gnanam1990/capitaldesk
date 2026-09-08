# CapitalDesk project status

The single authoritative record of what is built, what is proven and what is blocked.
Updated with every milestone. Where a claim is not backed by a command in this document, it
is not a claim.

- **Milestone:** M2 — the verified Binance read boundary (module 05).
- **Branch:** `feat/m2-binance-read-adapter`, branched from `main` at
  `f2f4d593308464d77b82e9dc395e95256afa17c9`.
- **Pull request:** opened for maintainer review; the head SHA is recorded in the pull request
  description rather than here.
- **Previous milestones:** M0 merged as
  [#1](https://github.com/gnanam1990/capitaldesk/pull/1); M1 merged as
  [#2](https://github.com/gnanam1990/capitaldesk/pull/2) at `f2f4d59`.
- **Module 03:** complete — see [docs/handoffs/03.md](handoffs/03.md).
- **Module 04:** complete — see [docs/handoffs/04.md](handoffs/04.md).
- **Module 05:** PARTIAL — deterministic and real-PostgreSQL paths complete; the authenticated
  venue boundary is BLOCKED on a missing credential. See [docs/handoffs/05.md](handoffs/05.md).

## What this milestone is, and is not

M0 resolved the ten reviewed contract findings and built the executable foundation. M1 adds
the authority model underneath the economic core: who the owner is, what an agent may propose,
and the scope every object lookup is bound by.

M2 adds the read boundary: narrow, origin-bound, credential-class-restricted readers for the
selected account and symbol, durable per-symbol trade cursors, and the worker catch-up that
assembles a bracketed observation cut and asks the shared coverage predicate for a verdict.

There is still **no economic behaviour**: no planner, no approvals, no dispatch and no write
adapter of any kind. The read boundary cannot express a write — it has one verb, and it takes
an endpoint name rather than a URL.

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
| Binance read boundary (module 05)        | Implemented; venue auth BLOCKED  | `packages/binance`, 188 unit cases; `docs/evidence/binance-read-capability.md` |
| Read cursors, snapshots and cuts         | Implemented                      | `packages/db` migration 0004, 22 integration cases on real PostgreSQL          |
| Worker ingest catch-up                   | Implemented                      | `apps/worker`, 15 integration cases on real PostgreSQL                         |
| Truthful health                          | Implemented                      | `apps/api`, 5 unit + 4 integration cases                                       |
| Worker and executor processes            | Start, assert boundary, idle     | `apps/worker`, `apps/executor`                                                 |
| Console shell and design tokens          | Implemented, browser-verified    | `apps/web`, 17 cases, screenshots in `artifacts/proofs/m0-foundation/ui/`      |
| Identity, sessions, agent credentials    | Implemented (module 03)          | `packages/domain`, `apps/api/src/auth`, 60 unit + 88 integration cases         |
| Same-origin console routing              | Implemented, proxy verified      | `apps/web/src/app/api-routing.ts`, 6 unit cases                                |
| Transactional journal (module 04)        | Implemented (module 04)          | `packages/db/src/journal`, 46 integration cases on real PostgreSQL             |
| CI                                       | Fresh checkout + real PostgreSQL | `.github/workflows/ci.yml`                                                     |
| Economic core (M1-M3)                    | Not started                      | —                                                                              |
| Venue integration                        | **Blocked**, see below           | —                                                                              |

## Commands and results at this head

Run from a clean tree at the branch head. The head SHA is recorded in the pull request
description rather than here, so this document does not have to be rewritten by the commit
that would change it:

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
| `pnpm run check:layering`                     | pass — 10 packages, 62 crossings checked                    |
| `pnpm run check:secrets`                      | pass — 262 files scanned                                    |
| `pnpm run test:unit`                          | **701 passed**, 0 skipped, 38 files                         |
| `pnpm run test:property`                      | **13 passed**, seed 20260908                                |
| `pnpm run test:integration`                   | **298 passed**, 23 files, against PostgreSQL 17.10          |
| `pnpm run test:integration` (no database URL) | **refused**, exit 1 — the gate no longer passes by skipping |
| `pnpm run build`                              | pass — all packages and apps                                |

The three test numbers are **workspace totals**, not per-area figures. The split by file:

| Suite       | Count | Where                                                                                                     |
| ----------- | ----- | --------------------------------------------------------------------------------------------------------- |
| unit        | 701   | contracts 284, binance 188, web 65, tools 39, api 38, config 35, domain 29, observability 23 (by package) |
| property    | 13    | `packages/contracts/src/money.property.test.ts`, seed 20260908                                            |
| integration | 298   | journal 141, auth 60, migrations 30, worker 21, CLI 20, identity scope 11, API 9, executor 6              |

No area's evidence is the workspace total. Module 03's own evidence is the 60 unit and 91
integration cases listed in [docs/handoffs/03.md](handoffs/03.md), module 04's the 119
integration cases in [docs/handoffs/04.md](handoffs/04.md), and module 05's the 188 unit and 37
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

Run the full gate from a fresh checkout of the branch head, push, and open the M1 pull
request for independent maintainer review. Not merged by the implementer. Modules 05, 06 and
07 are unblocked by this milestone.
