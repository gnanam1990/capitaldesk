# CapitalDesk project status

The single authoritative record of what is built, what is proven and what is blocked.
Updated with every milestone. Where a claim is not backed by a command in this document, it
is not a claim.

- **Milestone:** M1 — economic authority, part one: identity and access (module 03) and the
  transactional journal (module 04).
- **Branch:** `feat/m1-identity-journal`, branched from `main` at `338ab0a`.
- **Pull request:** not opened yet. It is opened once modules 03 and 04 are both complete and
  the branch is clean; the maintainer reviews and merges the exact verified head.
- **Previous milestone:** M0 was reviewed and **merged** as
  [#1](https://github.com/gnanam1990/capitaldesk/pull/1) at `338ab0afb3f64cc1cdb0422ad8644e0396953ede`.
- **Module 03:** complete — see [docs/handoffs/03.md](handoffs/03.md).
- **Module 04:** not started.

## What this milestone is, and is not

M0 resolved the ten reviewed contract findings and built the executable foundation. M1 adds
the authority model underneath the economic core: who the owner is, what an agent may propose,
and the scope every object lookup is bound by.

It still contains **no economic behaviour**: no ledger, no planner, no approvals, no dispatch,
no venue adapter. The console renders one page of truthful deployment state and has no login
screen — module 03 delivers the API's identity surface and the same-origin routing it needs,
not a console workflow.

Nothing here has touched a Binance account. There is no venue credential configured, so
there is no integration proof and none is claimed.

## Status by area

| Area                                     | Status                           | Evidence                                                                  |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| Reviewed findings F1-F10                 | Resolved in ADRs, specs amended  | `docs/adr/`, `specs/capitaldesk/AMENDMENTS.md`                            |
| Money, identity, state, digest contracts | Implemented                      | `packages/contracts`, 230 unit + 13 property tests                        |
| Environment contracts, fail-closed       | Implemented                      | `packages/config`, 28 cases                                               |
| Redacted logging                         | Implemented                      | `packages/observability`, 8 cases                                         |
| Migration lifecycle                      | Implemented                      | `packages/db`, 22 integration cases on real PostgreSQL                    |
| Dependency and credential boundaries     | Enforced by command              | `tools/`, 8 cases, verified to fail on real violations                    |
| Truthful health                          | Implemented                      | `apps/api`, 5 unit + 4 integration cases                                  |
| Worker and executor processes            | Start, assert boundary, idle     | `apps/worker`, `apps/executor`                                            |
| Console shell and design tokens          | Implemented, browser-verified    | `apps/web`, 17 cases, screenshots in `artifacts/proofs/m0-foundation/ui/` |
| Identity, sessions, agent credentials    | Implemented (module 03)          | `packages/domain`, `apps/api/src/auth`, 60 unit + 88 integration cases    |
| Same-origin console routing              | Implemented, proxy verified      | `apps/web/src/app/api-routing.ts`, 6 unit cases                           |
| Transactional journal (module 04)        | Not started                      | —                                                                         |
| CI                                       | Fresh checkout + real PostgreSQL | `.github/workflows/ci.yml`                                                |
| Economic core (M1-M3)                    | Not started                      | —                                                                         |
| Venue integration                        | **Blocked**, see below           | —                                                                         |

## Commands and results at this head

Run from a clean tree at the branch head. The head SHA is recorded in the pull request
description rather than here, so this document does not have to be rewritten by the commit
that would change it:

```sh
pnpm install --frozen-lockfile
pnpm run verify
CAPITALDESK_TEST_DATABASE_URL=postgres://localhost:5432/capitaldesk_test pnpm run test:integration
```

| Command                     | Result                                            |
| --------------------------- | ------------------------------------------------- |
| `pnpm run format:check`     | pass                                              |
| `pnpm run typecheck`        | pass                                              |
| `pnpm run lint`             | pass                                              |
| `pnpm run check:layering`   | pass — 9 packages, 43 crossings checked           |
| `pnpm run check:secrets`    | pass — 209 files scanned                          |
| `pnpm run test:unit`        | **506 passed**, 0 skipped, 31 files               |
| `pnpm run test:property`    | **13 passed**, seed 20260908                      |
| `pnpm run test:integration` | **135 passed**, 9 files, against PostgreSQL 17.10 |
| `pnpm run build`            | pass — all packages and apps                      |

The three test numbers are **workspace totals**, not per-area figures. The split by file:

| Suite       | Count | Where                                                                                                |
| ----------- | ----- | ---------------------------------------------------------------------------------------------------- |
| unit        | 506   | contracts 186, domain 57, config 20, web 35, api auth/cli 31, observability 8, tools 8, api 5, other |
| property    | 13    | `packages/contracts/src/money.property.test.ts`, seed 20260908                                       |
| integration | 135   | auth 56, migrations 30, identity scope 11, CLI 18, worker/executor 12, API 8                         |

No area's evidence is the workspace total. Module 03's own evidence is the 60 unit and 88
integration cases listed in [docs/handoffs/03.md](handoffs/03.md), not the workspace figures.

Toolchain: Node 22.23.1, pnpm 11.10.0, TypeScript 5.9.3, Fastify 5.12.3, Next 16.3.4,
React 19.2.8, Vitest 4.1.11, zod 4.5.4, PostgreSQL 17.10 (Homebrew, local).

## Blockers

| Blocker                                                              | Effect                                                                                                                                        | What would clear it                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| No authenticated Binance testnet credential is configured            | No integration proof of any kind. Account identity, symbol filters, commission rates, IOC behaviour and order correlation are all unverified. | The user configures an authorized Spot Testnet credential for the executor and reader roles. |
| No pre-trade fee bound derived                                       | Every shipped fee policy refuses dispatch (ADR-0010).                                                                                         | Module 14 derives a bound with an evidenced minimum fill size and partition granularity.     |
| No producer of a movement-universe proof or gap recovery certificate | Coverage cannot reach COMPLETE against a real account, so governed dispatch is unavailable (ADR-0002).                                        | Module 05, against a real account, with concrete cursor and retention evidence.              |
| Competition eligibility                                              | Unverified. Not pursued by this build.                                                                                                        | Separate, explicitly authorized decision.                                                    |

None of these blocks the independent implementation work in M1-M3. They block **claims of
proof**, which is why the code reports execution as unavailable rather than assuming it.

## Next action

Module 04 — the transactional journal — on the same branch. Migration `0003_journal.sql` is
reserved for it and no other module. The M1 pull request is opened only after module 04 is
complete, the full gate has been run from a fresh checkout, and the branch is clean.
