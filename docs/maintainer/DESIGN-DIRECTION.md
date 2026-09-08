# CapitalDesk visual direction — a calm capital operations desk

The user explicitly asks to be surprised by the frontend. Treat visual design as a first-class implementation deliverable. This direction intentionally refines the original blue/Fira baseline; record the token and typography amendments in UI-UX.md through a design ADR. Keep every accounting, accessibility and truthfulness requirement.

## Visual character

An editorial financial workspace: warm mineral surfaces, precise typographic hierarchy, restrained deep-teal actions, crisp hairlines, carefully aligned exact quantities and ample breathing space around high-stakes decisions. It should feel bespoke, confident and useful. Avoid generic SaaS KPI-card grids, neon crypto decoration, gratuitous gradients and unnecessary chart animation.

Starting palette, subject to measured contrast: canvas `#F5F6F2`, panels `#FFFFFF`, navigation `#EAEDE7`, ink `#172C29`, muted text `#52645D`, action teal `#087568`, border `#D5DED5`. Pale celadon `#DDEBCF` may highlight noncritical selections; never use a pale accent as small text. Use accessible semantic amber/red/green with labels and icons for actual states. Do not rely on color for economics.

Use one expressive, locally hosted sans family for headings/UI (for example Manrope if its licence and availability are verified) and a restrained monospace for exact quantities/IDs (for example IBM Plex Mono). Keep compact numeric columns tabular. Typography should establish hierarchy without making operational pages into a marketing hero.

Custom code-native identity: a minimal geometric CapitalDesk mark suggesting aligned ledger leaves. Use SVG/CSS, not raster image placeholders. Borders, spacing, small corner radii and subtle depth should be consistent; no nested card stacks everywhere.

## Signature functional surfaces

1. **Capital overview:** a strong page heading with environment/readiness context; a dominant per-asset capital composition view with exact available/reserved/quarantined/unassigned definitions; the next owner action visibly prioritized. Never sum unrelated assets. Real empty onboarding receives equal design care.
2. **Strategy lanes:** clear side-by-side or vertically responsive target/owned/committed relationships. Opposing intents show directional conflict and exactly which claims/limits differ. Not a fictitious price-performance chart.
3. **Decision sheet:** a spacious editorial order ticket showing maximum per-strategy debits, strictest limit, gross/net effect, residual and immutable FIFO. A hypothetical partial-fill scrubber may teach priority using labelled hypothetical data; it must not imply observed execution. Mobile approval must preserve readable limits.
4. **Execution rail:** a precise timeline separating approval, marker, venue observation, actual fills, accounting and reconciliation. UNKNOWN displays what is known, held and missing, last meaningful progress and valid next action.
5. **Evidence drawer:** human explanation first, exact source records/digest second. Copying exact numbers and tracing a displayed amount to its source must be effortless. Keep diagnostic implementation detail in progressive disclosure.

Navigation: Overview, Intents, Capital, Plans, Orders & Recovery, Evidence, Settings. Provide contextual deep links, working filters and keyboard focus. Persistent account/environment/freshness must remain legible without a row of noisy technical badges.

## Interaction and proof

Keep motion 120–220ms and functional; no moving number rows during inspection. Reduced motion is complete. Use explicit loading, empty, degraded, denied, expired, disconnected and conflict states. Preserve inspection position on streaming updates.

Responsive proof at 375/768/1024/1440; keyboard-only connect-to-review-to-recovery journey; 200% zoom; focus not obscured; semantic screen-reader announcements; actual text and focus contrast. Wide ledgers may use labelled bounded scrolling, never page-wide overflow.

Deliver a functioning design preview early on an explicit local fixture route/environment and screenshots of overview, conflict, decision sheet and UNKNOWN. Then replace development wiring with the accepted API and prove real state transitions. The fixture environment remains visibly labelled and cannot masquerade as a connected testnet account. No dead buttons, empty click handlers or hardcoded successful mutations.

Light is the required polished first theme. A night theme is optional only after the full owner workflow and light theme are verified. Use the final browser evidence to iterate spacing/type/state clarity, not just snapshots of component scaffolds.
