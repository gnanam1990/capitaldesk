import { loadWebPublicConfig } from '@capitaldesk/config';
import {
  EvidenceLink,
  PageIntro,
  Panel,
  PreviewGate,
  Quantity,
  StateChip,
  Stat,
  TableRegion,
  Timeline,
} from '../components/Console';
import { Icon } from '../components/Icons';
import { INTENTS, previewMode } from '../lib/preview-data';
import { healthUrl, parseReadiness, resolveDeploymentFacts, type Readiness } from './readiness';

export const dynamic = 'force-dynamic';

async function fetchReadiness(apiBaseUrl: string): Promise<Readiness> {
  try {
    const response = await fetch(healthUrl(apiBaseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    const report = parseReadiness(await response.json());
    return report === null
      ? { kind: 'unreachable', detail: 'the API returned an unreadable readiness response' }
      : { kind: 'reachable', report };
  } catch (error) {
    return {
      kind: 'unreachable',
      detail: error instanceof Error ? error.message : 'unknown transport failure',
    };
  }
}

async function LiveReadiness() {
  const config = loadWebPublicConfig();
  const readiness = await fetchReadiness(config.apiBaseUrl);
  const facts = resolveDeploymentFacts(config, readiness);
  const liveReady = readiness.kind === 'reachable' && readiness.report.status === 'ready';

  return (
    <section className={`cd-callout ${liveReady ? '' : 'cd-callout--danger'}`} aria-live="polite">
      <Icon name={liveReady ? 'check' : 'alert'} width="20" height="20" />
      <div>
        <strong>{liveReady ? 'API readiness confirmed' : 'Execution is unavailable'}</strong>
        <p>
          {readiness.kind === 'unreachable'
            ? `The API did not answer: ${readiness.detail}. This says nothing about venue account state.`
            : readiness.report.execution.reason}
        </p>
        <small className="cd-mono">
          {facts.source === 'api' ? 'API OBSERVATION' : 'CONSOLE CONFIG ONLY'} ·{' '}
          {facts.accountAlias}
        </small>
      </div>
    </section>
  );
}

export default function OverviewPage() {
  const demo = previewMode(process.env);
  return (
    <div className="cd-stack">
      <PageIntro
        eyebrow="Account control room"
        title="Capital, intent and evidence — in one view."
        summary="The desk separates owner authority, venue facts and accounting evidence so the next safe action is always explicit."
        action={
          <>
            <a className="cd-button cd-button--quiet" href="/evidence">
              Explore evidence
            </a>
            <a className="cd-button" href={demo ? '/demo' : '/plans'}>
              {demo ? 'Start interactive demo' : 'Review active plan'}{' '}
              <Icon name="arrow" width="17" height="17" />
            </a>
          </>
        }
      />

      {demo ? (
        <section className="cd-callout" aria-label="Demo scenario introduction">
          <Icon name="shield" width="20" height="20" />
          <div>
            <strong>One account. Three strategies. One accountable plan.</strong>
            <p>
              Explore a sample BTC/USDT desk: coordinate competing targets, inspect reserved
              capital, and follow an uncertain order through recovery. All account data is
              simulated; this demo does not connect to Binance or place orders.
            </p>
          </div>
        </section>
      ) : (
        <LiveReadiness />
      )}

      <PreviewGate>
        <div className="cd-stack">
          <div className="cd-grid-3">
            <Panel title="Coordinate" eyebrow="01 · Agent proposals">
              <p>
                Two strategies want to buy. A third wants to unwind. See the conflict before capital
                moves.
              </p>
              <EvidenceLink href="/intents">Inspect three targets</EvidenceLink>
            </Panel>
            <Panel title="Approve" eyebrow="02 · Owner control">
              <p>
                Inspect the shared plan, its capital reservation and the allocation each strategy
                would receive.
              </p>
              <EvidenceLink href="/plans">Review the sample plan</EvidenceLink>
            </Panel>
            <Panel title="Recover" eyebrow="03 · Evidence first">
              <p>
                A missing acknowledgement leaves funds reserved. Follow the evidence without
                resending the order.
              </p>
              <EvidenceLink href="/orders">Open recovery scenario</EvidenceLink>
            </Panel>
          </div>
          <div className="cd-stats">
            <Stat
              label="Available claim"
              value="12,750.00000000"
              unit="USDT"
              meta="Strategy-authorized and unreserved"
              tone="ok"
            />
            <Stat
              label="Reserved"
              value="4,500.00000000"
              unit="USDT"
              meta="Held by sealed plan CD-P1042"
              tone="warn"
            />
            <Stat
              label="Owner attention"
              value="03"
              meta="1 approval · 1 conflict · 1 drift"
              tone="danger"
            />
            <Stat
              label="Snapshot age"
              value="01.8"
              unit="s"
              meta="Simulated snapshot · fixed scenario"
              tone="ok"
            />
          </div>

          <div className="cd-grid">
            <Panel
              title="Intent queue"
              eyebrow="Coordination"
              action={<EvidenceLink href="/intents">Open queue</EvidenceLink>}
            >
              <TableRegion label="Development preview intent queue">
                <table className="cd-table">
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th>Revision</th>
                      <th data-align="right">Target</th>
                      <th data-align="right">Delta</th>
                      <th>Disposition</th>
                    </tr>
                  </thead>
                  <tbody>
                    {INTENTS.map((intent) => (
                      <tr key={intent.id}>
                        <td>
                          <strong>{intent.strategy}</strong>
                          <small>{intent.id}</small>
                        </td>
                        <td className="cd-mono">{intent.revision}</td>
                        <td data-align="right">
                          <Quantity amount={intent.target} asset="BTC" />
                        </td>
                        <td data-align="right">
                          <Quantity amount={intent.delta} asset="BTC" />
                        </td>
                        <td>
                          <StateChip tone={intent.state === 'CONFLICT' ? 'danger' : 'ok'}>
                            {intent.state}
                          </StateChip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableRegion>
            </Panel>

            <Panel title="Scenario evidence" eyebrow="Simulated source health">
              <ul className="cd-list">
                <li>
                  <div>
                    <strong>Account snapshot</strong>
                    <small>Complete asset coverage</small>
                  </div>
                  <StateChip tone="ok">1.8s</StateChip>
                </li>
                <li>
                  <div>
                    <strong>Symbol metadata</strong>
                    <small>BTCUSDT filters · revision 104</small>
                  </div>
                  <StateChip tone="ok">8m</StateChip>
                </li>
                <li>
                  <div>
                    <strong>Venue clock</strong>
                    <small>Observed offset +21ms</small>
                  </div>
                  <StateChip tone="ok">0.4s</StateChip>
                </li>
                <li>
                  <div>
                    <strong>Order recovery</strong>
                    <small>One correlation awaits a read</small>
                  </div>
                  <StateChip tone="unknown">UNKNOWN</StateChip>
                </li>
              </ul>
            </Panel>
          </div>

          <Panel
            title="Recent execution evidence"
            eyebrow="Fixture timeline"
            action={<EvidenceLink href="/orders">Open recovery</EvidenceLink>}
          >
            <Timeline
              items={[
                {
                  title: 'Plan CD-P1041 reconciled',
                  detail: 'Gross fill, fee allocation and ledger postings agree.',
                  time: '12:42:19 IST',
                  tone: 'ok',
                  icon: 'check',
                },
                {
                  title: 'Dispatch acknowledgement missing',
                  detail: 'The venue may have accepted CD-P1042. Reserved capital remains held.',
                  time: '12:39:04 IST',
                  tone: 'unknown',
                  icon: 'alert',
                },
                {
                  title: 'Opposing target detected',
                  detail: 'Protective unwind stays queued; it does not cancel an in-flight order.',
                  time: '12:37:51 IST',
                  tone: 'warn',
                },
              ]}
            />
          </Panel>
        </div>
      </PreviewGate>
    </div>
  );
}
