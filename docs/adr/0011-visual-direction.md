# ADR-0011 — Visual direction: a calm capital operations desk

- Status: accepted
- Date: 2026-09-08
- Amends: UI-UX.md section 2 (design tokens and typography)

## Context

UI-UX.md specifies a Swiss/minimal enterprise console on a slate-blue palette with Fira Sans
and Fira Code. The maintainer direction refines this deliberately and asks that the amendment
be recorded here rather than applied silently. Every accounting, accessibility and
truthfulness requirement in UI-UX.md is retained unchanged.

## Decision

### 1. Character

An editorial financial workspace: warm mineral surfaces, precise typographic hierarchy,
restrained deep-teal actions, crisp hairlines, aligned exact quantities and space around
high-stakes decisions. Explicitly avoided: generic SaaS KPI-card grids, neon crypto
decoration, gratuitous gradients, animated charts, nested card stacks.

### 2. Palette

Canvas `#F5F6F2`, panels `#FFFFFF`, navigation `#EAEDE7`, ink `#172C29`, muted `#52645D`,
action teal `#087568`, border `#D5DED5`, celadon `#DDEBCF` for non-critical selection only.

Two corrections were made against measurement rather than by eye:

- `--cd-ink-subtle: #46564f` was darkened from the starting muted value, because small
  metadata sits on the navigation surface rather than on white and needed 4.5:1 there.
- Celadon is never text. A committed test asserts it fails 4.5:1 on a panel, so its use as a
  text colour would be caught rather than debated.

All twelve declared token pairs meet 4.5:1, verified by a test that computes WCAG ratios from
the token file independently of any browser.

### 3. Typography

Manrope (variable) for headings and UI; IBM Plex Mono for exact quantities, identifiers and
digests. Both are OFL-1.1 and self-hosted through `@fontsource`, verified before adoption —
no CDN and no network font fetch from an operational console. Numerals are tabular
everywhere.

### 4. Identity

A code-native mark: four aligned ledger leaves in SVG, inheriting `currentColor`. No raster
placeholder.

### 5. Motion

120-220ms, functional only. Numeric rows never move under inspection. `prefers-reduced-motion`
is complete, driven by a token so it cannot be partially honoured.

### 6. Theme scope

Light is the required first theme, and it is the only one until the full owner workflow and
the light theme are verified. A dark theme is a later, separately verified addition rather
than a toggle added early and left unchecked.

## Consequences

Two font packages become runtime dependencies of the console. In exchange the console renders
identically offline and leaks no request to a font CDN.

## Verification

Browser-verified at 375, 768, 1024 and 1440: no page-level horizontal overflow. Nine text
pairs and four status pills measured **with inherited opacity applied**, all at or above
4.5:1. That measurement found a real defect — a 0.68 opacity fading a 6.57:1 token to an
effective 3.19:1 — which is why the opacity is gone and a committed test now guards the
defect class.
