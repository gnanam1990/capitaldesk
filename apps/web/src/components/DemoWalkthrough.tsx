'use client';

import { useReducer } from 'react';
import { demoQuote, demoTransition, initialDemo, type DemoPhase } from '../lib/demo-workflow';
import { StatusPill } from './StatusPill';

const COPY: Record<DemoPhase, { step: string; title: string; detail: string }> = {
  conflict: {
    step: '01 / COORDINATE',
    title: 'Three agents. One shared account.',
    detail:
      'Momentum and Accumulation propose more BTC. Protective unwind proposes less. Opposing targets block a plan until the owner resolves the conflict.',
  },
  plan: {
    step: '02 / REVIEW',
    title: 'Two compatible targets. One exact plan.',
    detail:
      'The opposing target is deferred. Review a 0.03000000 BTC LIMIT IOC at a maximum 20,000 USDT/BTC, with an immutable FIFO allocation.',
  },
  approved: {
    step: '03 / SIMULATE',
    title: 'Capital reserved. Owner decision recorded.',
    detail:
      'The demo approval freezes quantities, limit and allocation. Choose a deterministic partial-fill response or explore a lost-response incident.',
  },
  partial: {
    step: '04 / VERIFY EVIDENCE',
    title: 'A partial fill is not final accounting.',
    detail:
      'The fixture reports 0.02000000 BTC filled and 0.01000000 BTC expired. Capital remains held until terminal order, fill and commission evidence are complete.',
  },
  unknown: {
    step: '04 / RECOVER',
    title: 'Response lost. Capital stays protected.',
    detail:
      'The simulated venue may have accepted the order. UNKNOWN preserves the dispatch marker and reservation across a simulated process restart. There is no resend.',
  },
  reconciled: {
    step: '05 / RECONCILE',
    title: 'Every filled atom has an owner.',
    detail:
      'Complete scenario evidence assigns 0.01000000 BTC to each strategy in FIFO order. The unfilled target stays unmet. Only now does the residual reserve release.',
  },
};

export function DemoWalkthrough() {
  const [state, dispatch] = useReducer(demoTransition, undefined, initialDemo);
  const copy = COPY[state.phase];
  const finalized = state.claimsFinalized;
  return (
    <div className="cd-stack">
      <section className="cd-panel" aria-label="Interactive simulation">
        <header className="cd-panel-head">
          <div>
            <span className="cd-kicker">{copy.step}</span>
            <h2>CapitalDesk in action</h2>
          </div>
          <StatusPill
            tone={
              state.phase === 'unknown'
                ? 'unknown'
                : state.phase === 'conflict'
                  ? 'danger'
                  : finalized
                    ? 'ok'
                    : 'warn'
            }
          >
            SIMULATION · {state.phase.toUpperCase()}
          </StatusPill>
        </header>
        <div aria-live="polite" aria-atomic="true">
          <h3 style={{ fontSize: 'clamp(24px, 3vw, 38px)', marginBottom: 'var(--cd-s3)' }}>
            {copy.title}
          </h3>
          <p style={{ color: 'var(--cd-ink-muted)', maxWidth: '78ch' }}>{copy.detail}</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--cd-s3)', flexWrap: 'wrap' }}>
          {state.phase === 'conflict' && (
            <button className="cd-button" onClick={() => dispatch('defer')}>
              Simulate owner deferral
            </button>
          )}
          {state.phase === 'plan' && (
            <button className="cd-button" onClick={() => dispatch('approve')}>
              Approve demo plan
            </button>
          )}
          {state.phase === 'approved' && (
            <>
              <button className="cd-button" onClick={() => dispatch('partial')}>
                Simulate partial fill
              </button>
              <button className="cd-button cd-button--quiet" onClick={() => dispatch('timeout')}>
                Simulate lost response
              </button>
            </>
          )}
          {state.phase === 'unknown' && (
            <button className="cd-button cd-button--quiet" onClick={() => dispatch('restart')}>
              Simulate process restart
            </button>
          )}
          {(state.phase === 'partial' || state.phase === 'unknown') && (
            <button className="cd-button" onClick={() => dispatch('reconcile')}>
              Load complete fixture evidence
            </button>
          )}
          <button className="cd-button cd-button--quiet" onClick={() => dispatch('reset')}>
            Reset demo scenario
          </button>
        </div>
        <p
          style={{
            color: 'var(--cd-ink-muted)',
            marginTop: 'var(--cd-s3)',
            marginBottom: 0,
            fontSize: 13,
          }}
        >
          Browser-only simulation. No account connection, owner authorization, venue order, or real
          funds.
        </p>
      </section>
      <div className="cd-grid-3">
        <article className="cd-stat">
          <div className="cd-stat-top">Scenario reserve held</div>
          <strong className="cd-quantity">
            {demoQuote(state.reservedQuoteAtoms)} <small>USDT</small>
          </strong>
          <p>
            {finalized
              ? 'Released after complete fixture evidence'
              : 'Never released on a timeout alone'}
          </p>
        </article>
        <article className="cd-stat">
          <div className="cd-stat-top">Finalized scenario allocation</div>
          <strong className="cd-quantity">
            {finalized ? '0.02000000' : '0.00000000'} <small>BTC</small>
          </strong>
          <p>{finalized ? 'Finalized in simulation only' : 'No finalized allocation yet'}</p>
        </article>
        <article className="cd-stat">
          <div className="cd-stat-top">Simulated dispatch attempts</div>
          <strong className="cd-quantity">{state.simulatedAttempts}</strong>
          <p>Actual venue requests: 0 · automatic resend: 0</p>
        </article>
      </div>
      <div className="cd-grid">
        <section className="cd-panel">
          <header className="cd-panel-head">
            <div>
              <span className="cd-kicker">Frozen before demo approval</span>
              <h2>Intent & allocation schedule</h2>
            </div>
          </header>
          <div
            className="cd-table-region"
            role="region"
            aria-label="Scenario FIFO allocation"
            tabIndex={0}
          >
            <table className="cd-table">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Target BTC</th>
                  <th>{finalized ? 'Allocated BTC' : 'Disposition'}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>01 · Momentum</strong>
                    <small>First in FIFO</small>
                  </td>
                  <td className="cd-mono">0.01000000</td>
                  <td>
                    {finalized
                      ? '0.01000000'
                      : state.phase === 'conflict'
                        ? 'BUY · conflict'
                        : 'BUY · included'}
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>02 · Accumulation</strong>
                    <small>Second in FIFO</small>
                  </td>
                  <td className="cd-mono">0.02000000</td>
                  <td>
                    {finalized
                      ? '0.01000000'
                      : state.phase === 'conflict'
                        ? 'BUY · conflict'
                        : 'BUY · included'}
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>Protective unwind</strong>
                    <small>Opposing reduction proposal</small>
                  </td>
                  <td>Reduce holding</td>
                  <td>{state.phase === 'conflict' ? 'SELL · conflict' : 'DEFERRED'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p style={{ color: 'var(--cd-ink-muted)', margin: 'var(--cd-s4) 0 0', fontSize: 13 }}>
            {finalized
              ? 'Accumulation still needs 0.01000000 BTC. No automatic residual order is created.'
              : 'Deferral covers later Protective unwind revisions until owner reinstatement. Opposing proposals are never internally netted.'}
          </p>
        </section>
        <section className="cd-panel">
          <header className="cd-panel-head">
            <div>
              <span className="cd-kicker">Deterministic scenario facts</span>
              <h2>{finalized ? 'Reconciled fixture' : 'Plan boundaries'}</h2>
            </div>
          </header>
          <dl className="cd-facts">
            <div>
              <dt>Symbol / order</dt>
              <dd>BTCUSDT / LIMIT IOC</dd>
            </div>
            <div>
              <dt>Requested / filled</dt>
              <dd>
                {finalized || state.phase === 'partial'
                  ? '0.03000000 / 0.02000000 BTC'
                  : '0.03000000 BTC / not finalized'}
              </dd>
            </div>
            <div>
              <dt>{finalized ? 'Fixture fill price' : 'Maximum limit'}</dt>
              <dd>{finalized ? '19,900' : '20,000'} USDT/BTC</dd>
            </div>
            <div>
              <dt>{finalized ? 'Total cost + quote fee' : 'Maximum reserve'}</dt>
              <dd>{finalized ? '398.000 + 0.398 USDT' : '600.600 USDT'}</dd>
            </div>
            <div>
              <dt>Evidence source</dt>
              <dd>Local deterministic fixture</dd>
            </div>
          </dl>
          <p style={{ color: 'var(--cd-ink-muted)', margin: 'var(--cd-s4) 0 0', fontSize: 13 }}>
            Illustrative quote-fee policy: 0.1%. This is not a Binance account fee schedule. No live
            price is used in this scenario.
          </p>
        </section>
      </div>
      <section className="cd-panel">
        <header className="cd-panel-head">
          <div>
            <span className="cd-kicker">Inspectable decisions</span>
            <h2>Scenario event trail</h2>
          </div>
          <StatusPill tone="neutral">LOCAL ONLY</StatusPill>
        </header>
        <ol className="cd-list">
          {state.events.map((event, index) => (
            <li key={`${index}-${event}`}>
              <span>
                <strong className="cd-mono">{String(index + 1).padStart(2, '0')} · </strong>
                {event}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
