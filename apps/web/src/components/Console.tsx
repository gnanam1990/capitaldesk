import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icons';
import { StatusPill, type StatusTone } from './StatusPill';
import { previewMode } from '../lib/preview-data';

export function PageIntro({
  eyebrow,
  title,
  summary,
  action,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  action?: ReactNode;
}) {
  return (
    <header className="cd-page-head">
      <div>
        <span className="cd-kicker">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{summary}</p>
      </div>
      {action === undefined ? null : <div className="cd-page-action">{action}</div>}
    </header>
  );
}

export function PreviewBanner() {
  return (
    <aside className="cd-preview-banner" aria-label="Demo data disclosure">
      <Icon name="evidence" width="19" height="19" />
      <div>
        <strong>Demo workspace · fixture evidence</strong>
        <span>
          Explore sample strategies, capital and recovery evidence. Values are simulated and are not
          live account observations, venue fills, spendable claims, or execution proof.
        </span>
      </div>
    </aside>
  );
}

export function PreviewGate({ children }: { children: ReactNode }) {
  const enabled = previewMode(process.env);
  if (!enabled) {
    return (
      <section className="cd-unavailable" aria-labelledby="unavailable-title">
        <div className="cd-icon-well">
          <Icon name="shield" width="26" height="26" />
        </div>
        <span className="cd-kicker">Live data unavailable</span>
        <h2 id="unavailable-title">Live account data is not connected.</h2>
        <p>
          This workspace cannot load operational records yet. Return to the overview to check
          service readiness. A separately configured demo workspace provides labelled sample data.
        </p>
        <Link className="cd-button cd-button--quiet" href="/">
          Return to readiness
        </Link>
      </section>
    );
  }
  return (
    <>
      <PreviewBanner />
      {children}
    </>
  );
}

export function OperationalState({
  kind,
  title,
  detail,
  action,
}: {
  kind: 'pending' | 'degraded' | 'empty' | 'denied';
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  const tone: StatusTone =
    kind === 'pending'
      ? 'unknown'
      : kind === 'degraded'
        ? 'warn'
        : kind === 'denied'
          ? 'danger'
          : 'neutral';
  return (
    <article className="cd-panel">
      <StateChip tone={tone}>{kind.toUpperCase()}</StateChip>
      <h3 style={{ marginTop: 'var(--cd-s4)', fontSize: 19 }}>{title}</h3>
      <p style={{ margin: 'var(--cd-s2) 0 var(--cd-s4)', color: 'var(--cd-ink-muted)' }}>
        {detail}
      </p>
      {action}
    </article>
  );
}

export function Panel({
  title,
  eyebrow,
  children,
  action,
  className = '',
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`cd-panel ${className}`.trim()}>
      <header className="cd-panel-head">
        <div>
          {eyebrow === undefined ? null : <span className="cd-kicker">{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  unit,
  meta,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  unit?: string;
  meta: string;
  tone?: StatusTone;
}) {
  return (
    <article className="cd-stat">
      <div className="cd-stat-top">
        <span>{label}</span>
        <span className={`cd-stat-dot cd-stat-dot--${tone}`} aria-hidden="true" />
      </div>
      <strong className="cd-quantity">
        {value} {unit === undefined ? null : <small>{unit}</small>}
      </strong>
      <p>{meta}</p>
    </article>
  );
}

export function Quantity({
  amount,
  asset,
  label,
}: {
  amount: string;
  asset: string;
  label?: string;
}) {
  return (
    <span className="cd-quantity" aria-label={label ?? `${amount} ${asset}`}>
      {amount} <small>{asset}</small>
    </span>
  );
}

export function StateChip({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <StatusPill tone={tone}>{children}</StatusPill>;
}

export function FactList({ facts }: { facts: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="cd-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Timeline({
  items,
}: {
  items: ReadonlyArray<{
    title: string;
    detail: string;
    time: string;
    tone: StatusTone;
    icon?: IconName;
  }>;
}) {
  return (
    <ol className="cd-timeline">
      {items.map((item) => (
        <li key={`${item.time}-${item.title}`}>
          <span className={`cd-timeline-mark cd-timeline-mark--${item.tone}`}>
            <Icon name={item.icon ?? 'clock'} width="15" height="15" />
          </span>
          <div>
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
          </div>
          <time className="cd-mono">{item.time}</time>
        </li>
      ))}
    </ol>
  );
}

export function EvidenceLink({
  href = '/evidence',
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  return (
    <Link className="cd-evidence-link" href={href}>
      {children}
      <Icon name="arrow" width="15" height="15" />
    </Link>
  );
}

export function TableRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cd-table-region" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
