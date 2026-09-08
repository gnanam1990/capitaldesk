# CapitalDesk maintainer direction

User-authorized project, 8 September 2026. The user requests that the implementation session perform the implementation, with an independent coordinating maintainer through completion. The user authorizes project commits, pushes, pull requests and reviewed merges. The user also delegates the frontend visual direction and asks for an exceptional, surprising UI/UX.

## Repository and ownership

- Work only in `/Users/kratos/Documents/Codex/2026-09-08/it/work/capitaldesk` and project-specific child worktrees. Do not modify other projects, including Corporate Action Guard, and do not interrupt other implementation sessions.
- GitHub authenticated login was checked as `gnanam1990`. No CapitalDesk repository appeared in the account's 200-repository listing. Before creating, check `gnanam1990/capitaldesk` directly; if absent, create that repository PRIVATE using existing GitHub authorization. Never change an existing repository's visibility or overwrite it.
- Inspect this folder and ancestors before writing. Initially it contains specifications and review artifacts only. Establish a clean main baseline for these inputs, then use small coherent feature branches and PRs. No force pushes, history rewriting, deleting unrelated state, bypassing required checks or touching credentials.
- The implementer opens PRs; the maintainer independently reviews the exact PR head, directs fixes, and authorizes/executes merges after required tests and current review threads are addressed. Do not self-merge a new PR before maintainer signoff. Continue independent preparation while review is pending, without mixing unreviewed contracts.
- No new deployment, funded exchange action, account funding, withdrawal, paid purchase, hackathon submission or public publication is authorized by this build. Do not retrieve or copy unrelated secrets. Missing authenticated venue proof is a bounded blocker, not a reason to stop the entire build or invent successful integration.

## Authority and review inputs

Read `specs/capitaldesk/README.md`, PRD, TDD, TEST-PLAN, IMPLEMENTATION-PLAN, UI-UX, SOURCES and prompts/SESSION-HEADER. Read `docs/maintainer/CapitalDesk-Deep-Analysis-2026-09-08.md` and `DESIGN-DIRECTION.md` before implementing contracts. The review is a set of candidate contract changes to resolve precisely, not permission to weaken invariants. Distinguish demonstrated document mismatch, conditional risk and acknowledged upstream limitation.

The user now authorizes implementing the project and making the routine specification amendments required by that review. Maintain coordinated changes and ADRs. Preserve the original reviewed files in git history. Do not follow the old pack's stop-after-one-module instruction mechanically when the current assigned milestone explicitly spans multiple modules; complete that milestone and return a reviewable handoff.

## First PR: contract resolution and executable foundation

1. Inspect path, git state, licences, installed supported toolchain and read-only integration capabilities. Record exact versions and limitations; no exchange writes or new login/scopes in this slice.
2. Resolve F1–F10 in explicit ADRs plus synchronized specs/tests/prompts:
   - UNKNOWN liveness: document which outcomes are recoverable, what fences stale senders and what constitutes decisive evidence. Never release on repeated NOT_FOUND. If absence cannot be proven, represent unrecoverable historical uncertainty honestly. A testnet reset transition must be separately scoped, verified and preserve history; no live-money write-off or unproven reset shortcut.
   - Reconciliation: define executable account observation coverage and checkpoint predicates, disconnect/backfill handling, account-wide external activity detection, and unsupported coverage gates. Never invent a global sequence guarantee upstream does not supply.
   - Approval expiry: bind physical request timestamp/validity and signing lifecycle to approved expiry with explicit clock margins; prevent a paused old marker from obtaining a fresh unapproved validity window. Name the precise linearization boundary.
   - Preserve and correctly map EXPIRED_IN_MATCH / TRADE_PREVENTION and unknown future observations; unknown facts are distinct from unsupported outgoing actions.
   - Restore: define failure-domain durability/RPO for full approval, allocation and dispatch payloads, independent of exchange balances; recover lost FIFO only from surviving authentic local evidence.
   - Complete versioned/idempotent defer/reinstate, policy, credential revoke/rotate, archive, account-link and pool lifecycle contracts, including sealed-plan effects.
   - Separate read-only credential references, trade credential references and owner-session secrets with explicit identities; never grant reader TRADE authority.
   - Define sealed intent cohort, late opposite proposal handling and owner deferral scope across new revisions.
   - Freeze concentration formulas, asset treatment, freshness configuration, time source and fail-closed defaults.
   - Select a narrow evidence-supported initial fee policy. Model BNB fallback and combined fee/debit constraints only when supported; do not claim the independent small oracle proves the whole solver.
3. Establish pnpm/TypeScript/Fastify/Next/PostgreSQL workspace, strict validated environment contracts, dependency layering checks, minimal truthful health and CI from the beginning. Freeze money/ID/state/wire schemas and canonical digest fixtures. No fake production connectivity or code stubs presented as completed functionality.
4. Add one authoritative tracking document `docs/PROJECT-STATUS.md`: milestone, PR/head, implemented/partial/blocked, test commands/results, remaining work and next action. Store module handoffs in `docs/handoffs/` and the requirement trace in `docs/requirements-traceability.md`.
5. Commit coherent slices, run required checks and open the first PR. Return its URL, head SHA, exact test results, spec decisions and unresolved integration blockers. Stop only for this maintainer review gate, not for routine implementation choices.

## Following reviewed milestones

- Economic authority: identity, journal, baseline claims, absolute targets, mandates, deterministic planner, atomic reservations and exact approvals.
- Execution/recovery: isolated adapter, timed durable dispatch, fill/fee allocator, complete evidence reconciliation, drift, recovery, fault harness and restore. Use actual PostgreSQL and independent process scheduling where claimed. Demonstrate positive recoveries as well as conservative blocking.
- Product: full HTTP API, SDK/CLI, scoped proposal tools and two reference agents; implement the visual direction and complete functional owner workflow. Move shell/design proof earlier once contracts are stable. Each production view consumes truthful API data; examples live in an explicit fixture environment.
- Release: adversarial review, responsive and keyboard browser proof, exact-head CI, clean install/restore, version-bound evidence exports. Actual authenticated testnet proof is reported separately and requires the user's configured authorized testnet account. Complete all independent implementation even if that proof is blocked.

Each milestone must preserve one selected symbol, one account owner, one sealed/in-flight plan, actual fills only, immutable FIFO, no automatic residual trade, no direct agent execution and per-asset nonnegative accounting. Do not quietly add cross-strategy transfers or automatic netting.

## Collaboration and output quality

Use explicit fixtures to develop rare UI states, never production fallbacks. Do not weaken tests to obtain green output. Verify source contracts on official sources, pin versions and record exact evidence. Keep progress concise and disclose failures promptly. Avoid implementing every feature in one opaque commit or generating a large unverified scaffold. Keep the app runnable at accepted milestones.

This project is not done when docs or a pretty dashboard exist. It is done when its supported owner journey, economic state, persistence, authority, recovery and UI are implemented and verified, with unavailable external capabilities explicitly separated from completed local work.
