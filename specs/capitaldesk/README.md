# CapitalDesk — complete build specification

Prepared 8 September 2026. These are design and implementation instructions, not an implemented application or a production-readiness claim.

**Promise:** multiple proposal agents can work with one owner's Binance Spot account while a controlled executor preserves capital reservations, strategy inventory ownership, approvals and verifiable fill attribution.

## Separate deliverables

| File | Purpose |
|---|---|
| [PRD.md](PRD.md) | Problem, users, product scope, requirements and acceptance criteria |
| [TDD.md](TDD.md) | Technical design: accounting, algorithms, database, state machines, authority and APIs |
| [TEST-PLAN.md](TEST-PLAN.md) | Test-driven implementation workflow and adversarial verification matrix |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | Dependency order, milestones, real integration gates and release work |
| [UI-UX.md](UI-UX.md) | Modern operational interface, routes, interactions and accessibility |
| [SOURCES.md](SOURCES.md) | Verified evidence, competition, platform constraints and unresolved facts |
| [prompts/README.md](prompts/README.md) | Index of 30 separate implementation module prompts |
| [prompts/SESSION-HEADER.md](prompts/SESSION-HEADER.md) | Shared instructions to load before every module |

TDD here means **Technical Design Document**. The separate TEST-PLAN also specifies **test-driven development**, so both meanings are covered.

The pack contains 30 separate implementation prompts and 58 named adversarial test scenarios. Those scenarios are specified, not executed against a product in this documentation task.

## Start here

1. Read PRD, TDD and TEST-PLAN together.
2. Choose an implementation checkout during Prompt 00. This directory contains specifications only. No existing CapitalDesk code repository was inspected or assumed to exist.
3. Put this entire folder at `specs/capitaldesk/` in that checkout, or provide its absolute path to implementation. Preserve relative file relationships.
4. Load SESSION-HEADER and `prompts/00-integration-gate.md`; proceed through the numbered prompts according to IMPLEMENTATION-PLAN.
5. Every handoff records files, tests, observed integrations, blockers and next dependencies. Generated documents or green unit tests do not prove a live venue integration.

For this selected product, this pack is the implementation specification. Earlier OrderRescue, Binance idea research and CURRENT-HACKATHON-DIRECTION files remain background; their narrower state machines and stack defaults do not override this pack. Reuse code only after auditing its actual checkout and licence. Do not modify Corporate Action Guard merely because it appeared in earlier conversation.

## Scope in one page

- Complete first release: same owner, one Spot account, multiple strategies sharing the same base asset, target-position proposals, same-direction aggregation, opposite-direction conflict handling, reservations, approvals, LIMIT IOC execution, fills/fees attribution, recovery and a working web console.
- Each strategy owns internal accounting claims. These are not separate Binance wallets, exchange positions or customer custody accounts.
- Opposing strategy intents are not silently crossed or recorded as imaginary fills. Cross-strategy inventory transfers and internal matching require a future separately designed release.
- Execution safety applies to the controlled executor. An owner can still trade outside it; detected external activity stops affected planning until the account is reconciled.
- Spot Testnet provides the initial real execution boundary. The funded Agentic sub-account is not a fake-money testnet. Direct Agentic execution remains conditional on verified host, tool, confirmation and correlation capabilities.
- The full product is not promised to fit the current competition's remaining hours. Event participation and product completion are separate gates.

## Contract precedence

User instructions and repository instructions apply first. PRD defines product scope; TDD defines exact technical contracts; TEST-PLAN defines proof. Module prompts implement those contracts. If documents disagree, stop the affected module and record the conflict; do not pick the easiest interpretation. Approved changes require coordinated updates and regression cases.
