# CapitalDesk project status

The single authoritative record of what is built, what is proven and what is blocked.
Updated with every milestone. Where a claim is not backed by a command in this document, it
is not a claim.

- **Milestone:** M0 — integration gate and executable foundation (prompts 00-02, plus the
  workspace half of 01 and the shell foundation of 21).
- **Branch:** `feat/m0-contract-resolution-and-foundation`
- **Pull request:** opened for maintainer review; not merged, not self-merged.
- **Baseline:** `main` holds the reviewed specification pack only.

## What this milestone is, and is not

It resolves the ten reviewed contract findings and builds the executable foundation the rest
of the product sits on. It contains **no economic behaviour**: no ledger, no planner, no
approvals, no dispatch, no venue adapter. The console renders one page of truthful
deployment state.

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

| Command                     | Result                                                                            |
| --------------------------- | --------------------------------------------------------------------------------- |
| `pnpm run format:check`     | pass                                                                              |
| `pnpm run typecheck`        | pass                                                                              |
| `pnpm run lint`             | pass (from a cold tree)                                                           |
| `pnpm run check:layering`   | pass — 8 packages, 26 crossings checked                                           |
| `pnpm run check:secrets`    | pass — 147 files scanned                                                          |
| `pnpm run test:unit`        | **230 passed**, 0 skipped, 14 files                                               |
| `pnpm run test:property`    | **13 passed**, seed 20260908                                                      |
| `pnpm run test:integration` | **22 passed** against PostgreSQL 17.10; 22 skipped when no database is configured |
| `pnpm run build`            | pass — all packages and apps                                                      |

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

Maintainer review of the M0 pull request at its exact head. On merge, M1 begins with prompt
03 (identity and access) and prompt 04 (transactional journal).
