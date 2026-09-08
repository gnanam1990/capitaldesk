# Prompt 21 — Modern application shell and accessible design system

**Dependencies:** Prompt 17  
**Requirements:** FR-020, FR-024  
**Owns:** apps/web tokens, shell, auth boundary and shared components

> **Amended by [ADR-0011](../../../docs/adr/0011-visual-direction.md).** Implement the
> warm-mineral, deep-teal direction with Manrope and IBM Plex Mono, self-hosted. Verify
> contrast **with inherited opacity applied**, not on the token values alone.
>
> **Dependency corrected.** This module's task text requires a typed SDK, which module 19
> delivers, while its declared dependency list names only module 17. The shell is
> fixture-and-health only until module 19 lands; SDK wiring is explicitly deferred rather
> than assumed available.

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 21 only.

Objective: Create the operational console specified in UI-UX.md.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Read UI-UX.md completely. Use its institutional Swiss-style layout, Fira Sans/body and Fira Code/quantities, light/dark semantic tokens and restrained motion.
2. Build responsive navigation, permanent environment/account/mode badge, freshness indicator, command/search palette and contextual page actions.
3. Implement reusable quantity-with-unit, gross/net fee row, FIFO allocation list, status/reason chip, evidence link, pending/degraded/empty/denied components.
4. Use server-mediated typed SDK data, App Router server components and narrow interactive client islands. Never expose server auth or venue secrets to the browser.
5. Build accessible tables/cards, visible focus, 44px touch targets, labelled controls, one relevant live status region and reduced-motion behavior.
6. Create component examples for long amounts/IDs, unsupported execution, reset epoch and UNKNOWN, clearly isolated from production routes.

Required verification:
T-046–T-049; 375/768/1024/1440, keyboard, color-independent state, contrast and no hydration/console errors.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
The console never disguises unavailable execution or stale evidence as success.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/21.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

