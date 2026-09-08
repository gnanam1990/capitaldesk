import type { ReactNode } from 'react';
import { loadWebPublicConfig } from '@capitaldesk/config';
import { StatusPill, type StatusTone } from '../components/StatusPill';
import { healthUrl, parseReadiness, resolveDeploymentFacts, type Readiness } from './readiness';

export const dynamic = 'force-dynamic';

/**
 * The console shows what the API actually reported.
 *
 * When the API is unreachable this renders a degraded state naming the failure — not zeroed
 * balances, not a cached optimistic view and not a placeholder account (UI-UX section 4).
 */
async function fetchReadiness(apiBaseUrl: string): Promise<Readiness> {
  try {
    const response = await fetch(healthUrl(apiBaseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    // A 503 with a valid not_ready report is a reachable API reporting a real state, not a
    // transport failure, and must not be presented as one.
    const report = parseReadiness(await response.json());
    if (report === null) {
      return {
        kind: 'unreachable',
        detail: 'the API returned a response this console cannot read',
      };
    }
    return { kind: 'reachable', report };
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
  const facts = resolveDeploymentFacts(config, readiness);

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
          <StatusPill tone="neutral">{facts.deploymentEnvironment.toUpperCase()}</StatusPill>
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
        <Panel
          title={
            facts.source === 'api'
              ? 'Deployment (reported by API)'
              : 'Deployment (console configuration)'
          }
        >
          <dl style={{ margin: 0, display: 'grid' }}>
            <Fact label="Account alias" value={facts.accountAlias} mono />
            <Fact label="Environment" value={facts.deploymentEnvironment} mono />
            <Fact label="Baseline epoch" value={facts.baselineEpoch} mono />
            <Fact label="Build" value={facts.buildId} mono />
          </dl>
          {facts.mismatches.length > 0 ? (
            <p className="cd-note" role="status">
              This console&apos;s configuration disagrees with the API on{' '}
              {facts.mismatches.join(', ')}. The API&apos;s values are shown above. A console
              pointed at an API it was not configured for is a deployment fault, not a display
              detail.
            </p>
          ) : null}
          <p style={{ fontSize: 13, color: 'var(--cd-ink-subtle)', margin: 'var(--cd-s3) 0 0' }}>
            {facts.source === 'api'
              ? 'Reported by the API. An alias is an operator label, not an account identity: identity is the venue\u2019s own stable account id, established only after an authenticated read.'
              : 'This console\u2019s own configuration, shown because the API did not answer. It has not been observed and does not describe the API.'}
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
