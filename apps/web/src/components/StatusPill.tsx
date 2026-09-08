import type { ReactNode } from 'react';

export type StatusTone = 'ok' | 'warn' | 'danger' | 'unknown' | 'neutral';

const GLYPH: Record<StatusTone, string> = {
  ok: '✓',
  warn: '!',
  danger: '×',
  unknown: '?',
  neutral: '–',
};

const SURFACE: Record<StatusTone, { bg: string; fg: string }> = {
  ok: { bg: 'var(--cd-ok-surface)', fg: 'var(--cd-ok)' },
  warn: { bg: 'var(--cd-warn-surface)', fg: 'var(--cd-warn)' },
  danger: { bg: 'var(--cd-danger-surface)', fg: 'var(--cd-danger)' },
  unknown: { bg: 'var(--cd-unknown-surface)', fg: 'var(--cd-unknown)' },
  neutral: { bg: 'var(--cd-sunken)', fg: 'var(--cd-ink-subtle)' },
};

/**
 * A state indicator carrying a glyph and a text label, never colour alone (UI-UX section 10,
 * WCAG 1.4.1). The glyph is marked presentational because the label already says the state.
 */
export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const surface = SURFACE[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--cd-s2)',
        padding: '2px 10px',
        borderRadius: 999,
        background: surface.bg,
        color: surface.fg,
        border: `1px solid ${surface.fg}33`,
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true" style={{ fontFamily: 'var(--cd-font-mono)' }}>
        {GLYPH[tone]}
      </span>
      {children}
    </span>
  );
}
