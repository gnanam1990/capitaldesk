import type { ReactNode } from 'react';
import { loadWebPublicConfig } from '@capitaldesk/config';
import { StatusPill, type StatusTone } from '../components/StatusPill';

export const dynamic = 'force-dynamic';

interface ReadinessReport {
  status: 'ready' | 'not_ready';
  buildId: string;
  contractsVersion: string;
  deploymentEnvironment: string;
  accountAlias: string;
  baselineEpoch: number;
  dependencies: Array<{ name: string; state: string; detail: string }>;
  execution: { available: false; reason: string };
}

type Readiness =
  { kind: 'reachable'; report: ReadinessReport } | { kind: 'unreachable'; detail: string };

/**
 * The console shows what the API actually reported.
 *
 * When the API is unreachable this renders a degraded state naming the failure — not zeroed
 * balances, not a cached optimistic view and not a placeholder account (UI-UX section 4).
 */
async function fetchReadiness(apiBaseUrl: string): Promise<Readiness> {
  try {
    const response = await fetch(`${apiBaseUrl}/health/ready`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    return { kind: 'reachable', report: (await response.json()) as ReadinessReport };
  } catch (error) {
    return {
      kind: 'unreachable',
      detail: error instanceof Error ? error.message : 'unknown transport failure',
    };
  }
}

function Panel({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="cd-panel">
      <h2 className="cd-panel-title">{title}</h2>
      <div style={{ marginTop: 'var(--cd-s4)' }}>{children}</div>
    </section>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="cd-fact">
      <dt>{label}</dt>
      <dd className={mono === true ? 'cd-mono' : undefined}>{value}</dd>
    </div>
  );
}

export default async function OverviewPage() {
  const config = loadWebPublicConfig();
  const readiness = await fetchReadiness(config.apiBaseUrl);

  const apiTone: StatusTone =
    readiness.kind === 'unreachable'
      ? 'danger'
      : readiness.report.status === 'ready'
        ? 'ok'
        : 'warn';

  return (
    <div className="cd-stack">
      <header style={{ display: 'grid', gap: 'var(--cd-s3)' }}>
        <h1 className="cd-page-title">Overview</h1>
        <p className="cd-lede">
          This console governs one Binance Spot account. Nothing here is connected to a venue yet:
          no account has been reconciled, no strategy claims exist, and no execution path is
          implemented.
        </p>
        <div className="cd-pills">
          <StatusPill tone="neutral">{config.deploymentEnvironment.toUpperCase()}</StatusPill>
          <StatusPill tone={apiTone}>
            {readiness.kind === 'unreachable'
              ? 'API unreachable'
              : `API ${readiness.report.status}`}
          </StatusPill>
          <StatusPill tone="warn">Execution unavailable</StatusPill>
          <StatusPill tone="unknown">No baseline</StatusPill>
        </div>
      </header>

      <div className="cd-grid">
        <Panel title="Deployment">
          <dl style={{ margin: 0, display: 'grid' }}>
            <Fact label="Account alias" value={config.accountAlias} mono />
            <Fact label="Environment" value={config.deploymentEnvironment} mono />
            <Fact label="Baseline epoch" value={String(config.baselineEpoch)} mono />
            <Fact label="Build" value={config.buildId} mono />
          </dl>
          <p style={{ fontSize: 13, color: 'var(--cd-ink-subtle)', margin: 'var(--cd-s3) 0 0' }}>
            An alias is an operator label, not an account identity. Identity is the venue&apos;s own
            stable account id, established only after an authenticated read.
          </p>
        </Panel>

        <Panel title="Execution readiness">
          {readiness.kind === 'unreachable' ? (
            <p style={{ margin: 0, color: 'var(--cd-danger)' }}>
              The API did not respond ({readiness.detail}). No account state can be shown. This is a
              transport failure, not evidence about the account.
            </p>
          ) : (
            <>
              <dl style={{ margin: 0, display: 'grid' }}>
                {readiness.report.dependencies.map((dependency) => (
                  <Fact
                    key={dependency.name}
                    label={dependency.name}
                    value={`${dependency.state} — ${dependency.detail}`}
                  />
                ))}
                <Fact label="Contracts version" value={readiness.report.contractsVersion} mono />
              </dl>
              <p className="cd-note">{readiness.report.execution.reason}</p>
            </>
          )}
        </Panel>
      </div>

      <Panel title="Next owner action">
        <p style={{ margin: 0, maxWidth: '62ch' }}>
          There is no action to take yet. Connecting an account requires the read adapter and the
          baseline ledger, which are not implemented. The milestone status, its evidence and what is
          blocked are tracked in <span className="cd-mono">docs/PROJECT-STATUS.md</span>.
        </p>
      </Panel>
    </div>
  );
}
