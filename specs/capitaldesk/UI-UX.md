# CapitalDesk — UI and Interaction Specification

Version: 1.1, amended 8 September 2026  
Date: 8 September 2026  
Related: [PRD](PRD.md), [technical design](TDD.md), [test plan](TEST-PLAN.md), [module prompts](prompts/README.md), [amendments](AMENDMENTS.md)

> **Amended.** Section 2 is superseded by ADR-0011; sections 5, 8 and 9 carry amendments
> from ADR-0006 and ADR-0001. Every accessibility and truthfulness requirement is retained.

## 1. Product feel and purpose

CapitalDesk is an operational console for an account owner coordinating multiple proposal agents. The first screen must explain account readiness, committed capital, proposed changes, and anything requiring intervention. The primary visual material is evidence, quantities, and state transitions.

Use a restrained Swiss/minimal enterprise style: strong alignment, clear typography, dense but readable information, a quiet light surface, and blue emphasis. The UI/UX skill informed the palette, typography, density, accessibility, and interaction rules. Its generic landing-page hero pattern is deliberately inapplicable to this operational console.

Real data drives production routes. A component library or fixture preview can contain labelled sample states; it must not fall through into production as a fake connected account, successful execution, invented balance, or manufactured performance chart.

## 2. Design tokens

> **Superseded by [ADR-0011](../../docs/adr/0011-visual-direction.md).** The palette below is
> replaced by the warm-mineral, deep-teal direction, and Fira Sans/Fira Code by Manrope and
> IBM Plex Mono (both OFL-1.1, self-hosted). The implemented tokens live in
> `apps/web/src/app/tokens.css` and all twelve declared pairs are asserted at 4.5:1 by a
> committed test. The requirements in this section — semantic tokens rather than repeated hex
> values, validated foreground/background pairs, tabular figures, 4px spacing, 44px touch
> targets, functional short motion, honoured reduced motion — are retained unchanged and are
> what ADR-0011 implements.

| Token | Light default | Optional dark |
|---|---|---|
| Page | `#F8FAFC` | `#0B1220` |
| Panel | `#FFFFFF` | `#111C2E` |
| Primary text | `#0F172A` | `#F1F5F9` |
| Secondary text | `#475569` | `#CBD5E1` |
| Border | `#CBD5E1` | `#334155` |
| Primary action | `#1E3A5F` with white text | `#93C5FD` with `#0B1220` text |
| Link / focus accent | `#2563EB` | `#93C5FD` |
| Warning text | `#A16207` on a tested pale-warning surface | `#FCD34D` on a tested dark-warning surface |
| Error text | `#B91C1C` | `#FCA5A5` |
| Success text | `#166534` | `#86EFAC` |

Treat these as named semantic tokens, not raw hex values repeated throughout components. Validate actual foreground/background pairs; an accent token is not universally suitable as small text on every surface.

Use Fira Sans for body and interface text; use Fira Code for quantities, IDs, and technical evidence. Provide self-hosted or local fallback stacks. Numeric columns use tabular figures and decimal alignment. The default body is 16px, table text 14px, metadata at least 12px, with adequate line height.

Use a 4px base spacing system. Operational layouts use 8–32px gaps, 12–16px panel padding, 8px row gaps where needed, and 8–12px corner radii. Compact visual controls retain a 44×44px touch target through padding. Use one consistent SVG icon set; status icons always have text labels.

Transitions are short and functional: approximately 120–180ms for hover/focus and 180–240ms for a drawer. Animate opacity/transform without moving numeric rows under inspection. Honor `prefers-reduced-motion`. Do not add looping charts, particle backgrounds, or scrolling number effects.

## 3. Navigation and persistent context

Primary navigation: Overview, Intents, Capital, Plans, Orders & Recovery, Evidence, Settings. The account switcher may initially contain one account but must never suggest that changing display context changes credential identity.

Persistently show: account alias and masked identity, `TESTNET`/`LIVE`/`READ-ONLY`, integration mode, baseline epoch, source freshness, and whether execution is eligible. These are separate facts. “Connected” is not equivalent to “safe to execute.”

Use stable deep links for strategy, intent revision, plan, order attempt, incident, and export. Browser back/forward and filter state must work. Preserve user inspection position during background refresh; show a “new events” cue before inserting rows above the current viewport.

Desktop uses a narrow left navigation and a flexible main region. Tablet can collapse labels. Mobile uses a menu or bottom navigation of at most five primary entries, with additional destinations in an accessible menu. The current account and environment remain visible.

## 4. Overview

The opening region answers three questions: can this account execute, how much authorized capital is committed, and what needs owner attention?

Show an execution-readiness banner with actionable reasons. Below it, show per-asset capital summaries, pending approvals, open uncertainty, and conflict counts. Do not combine different asset quantities into one number. Any fiat valuation is explicitly an estimate with price source and timestamp.

The main body contains an intent queue and a compact recent-execution timeline. A right-side panel at wide widths shows source health and the highest-priority incident. On smaller screens it becomes a normal section in reading order.

Empty state explains how to establish the baseline or register the first agent. Loading uses stable skeletons; a source outage shows the last observed data, its age, and disabled dependent actions rather than zero balances.

## 5. Intent queue and strategy inspection

Each intent row shows strategy, selected symbol, absolute target, current confirmed claim, existing commitment, remaining delta, limit constraint, revision, expiry, and state. Quantity labels include the asset unit. A buy target is never phrased as an instruction to “buy this amount again.”

A conflict view shows the actual opposing directions and affected claims. Offer permitted actions: defer an intent or open a revision workflow. *(ADR-0006: a deferral binds the strategy's target, not one revision, so the UI must say that a newer revision from that strategy stays deferred until the owner reinstates.)* Explain how this changes the resulting plan. Do not offer a one-click “net them” action.

A strategy drawer shows owner-assigned claims, budget authority, pending reservations, actual fill history, and the proposal identity. Explain that these are virtual claims in one account. An agent cannot appear to have a separate exchange wallet or exchange-native position.

New revisions show a readable before/after diff. A stale revision submission receives an inline error and a link to the current version. The UI must not silently replace a newer intent with an older tab's form state.

## 6. Capital ledger

Use an asset-first ledger: asset, confirmed account quantity, assigned strategy claims, reserved quantity, unassigned quantity, applicable fee reserve, and unresolved difference. Exact definitions come from the technical design; the UI must not invent a balance by subtracting unrelated columns.

Selecting an asset expands strategy allocations and evidence. Every adjustment shows who authorized it, reason, effective epoch, and whether it is an internal claim reassignment or an actual venue movement. These are distinct actions.

An unassigned bucket is visible and cannot be hidden as dust. Unresolved differences use an incident link. The ledger must never present an uncertain quantity as spendable merely because the exchange currently reports a sufficient balance.

Tables provide numeric alignment, sticky headers where useful, accessible sorting, and paginated/virtualized history without losing row semantics. On mobile, summary rows become labelled cards; detailed tables use an explicitly labelled horizontal scroll region if necessary.

## 7. Plan review and approval

The approval surface is a dedicated page or spacious drawer containing account/environment, plan expiry, source freshness, owner budget checks, participating intent revisions, exact order parameters, maximum reserved amount with fee policy, and the fixed FIFO allocation schedule.

Show gross requested quantity separately from the net target and the conservative fee-adjusted residual. Expose each strategy's maximum asset debit, fee/rounding policy and allocation-policy version. Final quote/fee attribution waits for complete evidence; provisional figures have an explicit label. A fully filled child is not automatically a satisfied net target.

Explain the strictest-limit choice in plain language: which participant constrains the combined price and what remains unfilled if the IOC cannot match. Show that opposite directions require resolution before a plan exists.

Provide an expandable technical section for the plan digest and full canonical payload; keep these out of the main narrative unless needed for diagnosis. The owner can download the review data.

The primary action says “Approve this plan,” with the exact consequence nearby. In a managed MCP mode, local approval leads to a separate visible native-confirmation step. It does not say “Executed” while host confirmation remains pending.

Any material change invalidates the review state, removes the enabled approval action, and shows a precise diff. Do not preserve a green approved badge after changed price, quantity, allocation, account, epoch, or expiry. Approving twice must yield the same approval outcome and cannot dispatch a second order.

## 8. Orders and recovery workbench

An order timeline separates prepared intent, approval, native confirmation when applicable, dispatch attempt, exchange acknowledgement, authoritative fills, terminal order evidence, allocation, and reconciled account state. Use timestamps with timezone and a UTC reveal/copy option.

`UNKNOWN` is a first-class visible state. Suggested copy: “The exchange may have accepted this order. Capital stays reserved while its status is checked.” The UI shows the current correlation ID, last evidence, reconciliation attempt, and next permitted action.

Never label a timeout “failed” unless authoritative evidence establishes rejection. Never show a retry button that creates a fresh order to resolve an uncertain existing one. “Recheck status” requests reconciliation and shows its result without creating an order.

> **Amended by ADR-0001.** An unresolved dispatch now has three visible outcomes rather than
> an indefinite UNKNOWN: `NOT_SENT_PROVEN` (the sender was fenced before any byte left; the
> reservation is released and a new approval is required to try again), continued `UNKNOWN`,
> and `IRRECOVERABLE_UNCERTAINTY` (absence cannot be proven; the liability is retained and
> there is no valid next action). The incident view must show the responsible role, the
> evidence awaited, the last meaningful progress, the assets held and the supported next
> action — or state plainly that none exists. Do not offer a recovery control where the
> backend has no valid transition.

A partial IOC result shows requested, filled, and terminal unfilled quantities, each strategy's FIFO allocation, execution prices, actual fees by asset, and remaining unmet targets. A terminal order status alone is not the same as final accounting reconciliation.

Drift incidents show expected versus observed quantities or activity, source records, affected plans, and blocked capabilities. Resolution requires evidence and an allowed action. There is no cosmetic “mark resolved” control that bypasses the domain state machine.

## 9. Evidence, export, and settings

The evidence inspector offers a human explanation first, followed by structured records, source identifiers, timestamps, account epoch, payload digest, and build version. Redact secrets before rendering or export. Preserve exact decimal text and IDs in copy actions.

Exports include provenance and unresolved items, with deterministic filenames and a visible completion state. A browser download completing must not imply the underlying incident is resolved.

Settings contain agent registration, symbol scope, owner budgets, risk mandates, freshness policy, account capability, and read-only credential metadata. *(ADR-0006: credential revoke and rotate, policy publication, strategy archive and pool halt/resume are enumerated lifecycle actions. Each shows its actor scope and its effect on a sealed plan — and after the dispatch marker the UI must present a halt as a refusal to dispatch again, never as a cancellation of an order the venue has accepted.)* Never display full API secrets or offer credentials to a proposal agent. Live enablement is a distinct authorized deployment/configuration workflow, not a decorative theme toggle.

Testnet reset displays a persistent epoch-invalid banner. The owner must establish a new baseline and assignments. Historical orders remain inspectable under their original epoch and cannot become claims in the new one.

## 10. State vocabulary and accessibility

| Meaning | Label and presentation | Required interaction |
|---|---|---|
| Opposing proposals | `CONFLICT`, directional icon, plain explanation | Owner defer/revise path; no dispatch. |
| Awaiting owner | `AWAITING APPROVAL`, plan summary | Review exact current plan. |
| Awaiting managed host | `AWAITING NATIVE CONFIRMATION` | Complete or reject the host confirmation when supported. |
| Uncertain venue outcome | `UNKNOWN`, warning icon | Inspect evidence and recheck status; keep dependent commitments blocked. |
| Partial actual execution | `PARTIALLY FILLED`, quantities | Inspect fills and allocations; distinguish terminal/unresolved state. |
| Account mismatch | `DRIFT QUARANTINE`, incident severity | Inspect source difference and allowed recovery actions. |
| Proven completion | `RECONCILED`, evidence link | Inspect authoritative outcome and ledger entries. |
| Invalid environment baseline | `EPOCH INVALID` | Establish a new reconciled baseline. |

Labels shown here describe UX semantics; bind them to actual domain enums in `TDD.md`. Avoid creating a parallel frontend state machine that can disagree with the backend.

All primary flows work by keyboard. Dialogs have a named title, focus trap, escape behavior when safe, and focus restoration. Loading and validation errors use appropriate `aria-live` regions without announcing every streamed market event. Inline errors identify the affected input and a recovery action; a focusable summary helps long forms.

Use color plus text/icon for every status. Meet normal-text contrast of at least 4.5:1 and appropriate component/focus contrast. The approval consequence must remain understandable at 200% zoom and with motion reduced. Tooltips supplement visible labels; they never contain the only explanation of a blocked financial action.

## 11. Required visual and interaction proof

Capture the connected baseline, competing-intent conflict, capital ledger, complete approval page, native-confirmation conditional state, `UNKNOWN` response-loss recovery, partial IOC result, drift quarantine, testnet reset, empty state, and source outage.

Validate widths 375, 768, 1024, and 1440 pixels; light theme is required, dark theme only if fully checked. Review keyboard-only navigation, visible focus, 200% zoom, reduced motion, screen-reader error announcements, exact decimal formatting, and long identifier overflow.

The end-to-end browser journey must consume the actual application API and worker-produced records. Component fixtures remain useful for rare states, but label their evidence separately from a real testnet journey.

UI completion requires working controls, truthful state copy, source freshness, responsive behavior, and a linked recovery path. A polished static screenshot alone does not satisfy FR-020 or FR-024.
