import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contrast regression guard for the design tokens.
 *
 * Browser verification found the navigation's unavailable items rendering at an effective
 * 3.19:1 — the token itself was fine at 6.57:1, but a 0.68 opacity on the element blended it
 * toward the background and the requirement was missed. These tests cover both halves: the
 * declared token pairs must meet 4.5:1, and no rule may reintroduce an opacity that fades
 * text below it.
 */

// fileURLToPath, not URL.pathname: the latter yields a percent-encoded, leading-slash path
// on Windows ("/C:/Users/..."), so readFileSync throws ENOENT and the whole suite fails there.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.join(HERE, 'tokens.css'), 'utf8');
const globalsCss = readFileSync(path.join(HERE, 'globals.css'), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokensCss);
  if (match === null) throw new Error(`token --${name} not found in tokens.css`);
  return match[1]!;
}

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, computed independently of any browser or library. */
function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['ink on canvas', 'cd-ink', 'cd-canvas'],
  ['ink on panel', 'cd-ink', 'cd-panel'],
  ['ink on navigation', 'cd-ink', 'cd-nav'],
  ['muted text on panel', 'cd-ink-muted', 'cd-panel'],
  ['muted text on canvas', 'cd-ink-muted', 'cd-canvas'],
  ['subtle text on panel', 'cd-ink-subtle', 'cd-panel'],
  ['subtle text on navigation', 'cd-ink-subtle', 'cd-nav'],
  ['action text on action surface', 'cd-action-ink', 'cd-action'],
  ['success text on its surface', 'cd-ok', 'cd-ok-surface'],
  ['warning text on its surface', 'cd-warn', 'cd-warn-surface'],
  ['danger text on its surface', 'cd-danger', 'cd-danger-surface'],
  ['unknown text on its surface', 'cd-unknown', 'cd-unknown-surface'],
];

describe('design token contrast', () => {
  for (const [name, foreground, background] of PAIRS) {
    it(`${name} meets 4.5:1`, () => {
      expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('never uses the pale celadon accent as text on a light surface', () => {
    // The direction permits celadon as a non-critical selection highlight only.
    expect(contrast(token('cd-celadon'), token('cd-panel'))).toBeLessThan(4.5);
    expect(globalsCss).not.toMatch(/color:\s*var\(--cd-celadon\)/);
  });

  it('focus outline is distinguishable from the surfaces it appears on', () => {
    // WCAG 2.2 non-text contrast: a focus indicator needs at least 3:1.
    expect(contrast(token('cd-focus'), token('cd-canvas'))).toBeGreaterThanOrEqual(3);
    expect(contrast(token('cd-focus'), token('cd-panel'))).toBeGreaterThanOrEqual(3);
  });

  // --- regression: browser verification, opacity fading text below 4.5:1 ---------------
  it('does not fade any text-bearing rule with opacity', () => {
    const offenders: string[] = [];
    const rulePattern = /(\.[a-z-]+(?:\s*[,>]\s*\.[a-z-]+)*)\s*\{([^}]*)\}/g;
    for (const match of globalsCss.matchAll(rulePattern)) {
      const [, selector = '', body = ''] = match;
      const opacity = /(?:^|[\s;])opacity:\s*([0-9.]+)/.exec(body);
      if (opacity === null) continue;
      // Compared as text rather than parsed: the workspace bans parseFloat outright so a
      // binary float can never appear on a money path, and this check does not need one.
      const value = opacity[1]!;
      const isFaded = value !== '1' && value !== '1.0';
      // A rule that both sets a text colour and fades it is the exact defect found in the
      // browser: the token measured fine while the rendered text did not.
      if (isFaded && /color:/.test(body)) {
        offenders.push(`${selector} sets color and opacity ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the reduced-motion override complete', () => {
    expect(tokensCss).toContain('prefers-reduced-motion: reduce');
    expect(tokensCss).toMatch(/--cd-motion:\s*0ms/);
  });

  it('defines the mono family for exact quantities and identifiers', () => {
    expect(tokensCss).toMatch(/--cd-font-mono:\s*'IBM Plex Mono'/);
    expect(globalsCss).toContain('font-variant-numeric: tabular-nums');
  });
});
