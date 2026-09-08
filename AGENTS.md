# CapitalDesk — repository instructions

**Source of truth:** the specification pack at `specs/capitaldesk/` (PRD, TDD, TEST-PLAN,
IMPLEMENTATION-PLAN, UI-UX, SOURCES and the 30 numbered module prompts), as amended by the
ADRs in `docs/adr/`. Read `specs/capitaldesk/prompts/SESSION-HEADER.md` before any module.

Earlier OrderRescue, Binance idea research and hackathon-direction material is background
only. Its narrower state machines and stack defaults do **not** override this pack. Do not
modify Corporate Action Guard or any other project from this repository.

## Precedence

User instructions, then this file, then PRD (product scope), then TDD (exact technical
contracts), then TEST-PLAN (proof). If documents disagree on a money or authorization
boundary, stop that slice and record the conflict — do not pick the easiest reading.
Amendments are made through an ADR plus coordinated updates to every affected document.

## Non-negotiable rules

- No JavaScript `number`, `parseFloat` or `Math.round` on any money or decision path.
  Quantities are per-asset integer atoms; prices are exact fixed-point.
- Never add quantities of different assets. Ledger transactions balance within each asset.
- A proposal agent can never dispatch, sign or authorize a venue order.
- Nothing may resend after a dispatch marker. UNKNOWN keeps capital reserved.
- Never present a mock, fixture or unimplemented path as working functionality, and never
  weaken a test to obtain green output.
- Secrets are references, never values. `VENUE_TRADE` mounts only in the executor,
  `VENUE_READ` only in the worker, `OWNER_SESSION` only in the API.

## Commands

```sh
pnpm install
pnpm verify          # format, lint, typecheck, layering, secrets, tests, build
pnpm test            # unit + property
pnpm check:layering  # dependency layering and trust boundaries
pnpm check:secrets   # credential-class boundary
pnpm db:status       # migration status (never destructive)
pnpm db:migrate      # apply pending forward migrations
```

## Where things are

- `docs/PROJECT-STATUS.md` — the single authoritative milestone/blocker record.
- `docs/adr/` — decisions amending the reviewed specification.
- `docs/handoffs/` — per-module evidence records.
- `docs/requirements-traceability.md` — FR/invariant to code and test mapping.

## Repository presentation

Do not add assistant branding, generated-by notices, session links, or automatic co-author trailers to repository files, commit messages, or pull requests. Preserve required third-party licence notices.
