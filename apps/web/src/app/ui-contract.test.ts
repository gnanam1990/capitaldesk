import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = path.dirname(fileURLToPath(import.meta.url));
const read = (...segments: string[]) => readFileSync(path.join(APP, ...segments), 'utf8');

describe('operational console truth and accessibility contract', () => {
  const css = read('globals.css');
  const pages = [
    'page.tsx',
    'capital/page.tsx',
    'strategies/page.tsx',
    'intents/page.tsx',
    'plans/page.tsx',
    'orders/page.tsx',
    'evidence/page.tsx',
    'settings/page.tsx',
    'ui-states/page.tsx',
  ];

  it('keeps every development fixture behind the explicit preview gate', () => {
    for (const page of pages.slice(1)) expect(read(page), page).toContain('<PreviewGate>');
    expect(read('page.tsx')).toContain('<PreviewGate>');
    expect(read('../components/Console.tsx')).toContain('Demo workspace · fixture evidence');
  });

  it('renders UNKNOWN recovery without a resend or generic retry control', () => {
    const orders = read('orders/page.tsx');
    expect(orders).toContain('UNKNOWN');
    expect(orders).toContain('There is no safe resend');
    expect(orders).toContain('Request read-only recheck');
    expect(orders).not.toMatch(/>Retry</);
  });

  it('keeps approval, submission and session deadlines as separate visible facts', () => {
    const plan = read('plans/page.tsx');
    expect(plan).toContain('Plan expiry');
    expect(plan).toContain('Submission deadline');
    expect(plan).toContain('Owner session expiry');
    expect(plan).toContain('Hypothetical partial fill');
    expect(plan).toContain('Actual allocation stays unknown');
  });

  it('declares mobile-first touch, focus, long-value and responsive protections', () => {
    expect(css).toContain('min-height: 44px');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).toContain('@media (min-width: 640px)');
    expect(css).toContain('@media (min-width: 1024px)');
    expect(css).toContain('@media (min-width: 1440px)');
    expect(read('tokens.css')).toContain('prefers-reduced-motion: reduce');
  });

  it('uses semantic tokens instead of component-local hex colors', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    for (const page of pages) expect(read(page), page).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
