import { FactList, PageIntro, Panel, PreviewGate, StateChip } from '../../components/Console';

export default function SettingsPage() {
  return (
    <div className="cd-stack">
      <PageIntro
        eyebrow="Owner controls"
        title="Authority, scope and lifecycle."
        summary="Credential references, mandates and environment capabilities remain explicit. Full secrets are never rendered or exposed to proposal agents."
      />
      <PreviewGate>
        <div className="cd-stack">
          <div className="cd-grid">
            <Panel
              title="Account capability"
              eyebrow="Binance Spot Testnet"
              action={<StateChip tone="warn">OBSERVATION ONLY</StateChip>}
            >
              <FactList
                facts={[
                  [
                    'Stable account identity',
                    <span className="cd-mono" key="id">
                      acct_72c4••••81d9
                    </span>,
                  ],
                  [
                    'Selected symbol',
                    <span className="cd-mono" key="symbol">
                      BTCUSDT
                    </span>,
                  ],
                  [
                    'Baseline epoch',
                    <span className="cd-mono" key="epoch">
                      12
                    </span>,
                  ],
                  [
                    'VENUE_READ',
                    <StateChip key="read" tone="ok">
                      MOUNTED
                    </StateChip>,
                  ],
                  [
                    'VENUE_TRADE',
                    <StateChip key="trade" tone="neutral">
                      NOT MOUNTED
                    </StateChip>,
                  ],
                  [
                    'Execution eligible',
                    <StateChip key="eligible" tone="warn">
                      NO
                    </StateChip>,
                  ],
                ]}
              />
            </Panel>
            <Panel title="Risk mandate v4" eyebrow="Published by owner">
              <ul className="cd-list">
                <li>
                  <span>Maximum plan debit</span>
                  <strong className="cd-mono">5,000.00000000 USDT</strong>
                </li>
                <li>
                  <span>Daily gross BUY</span>
                  <strong className="cd-mono">12,000.00000000 USDT</strong>
                </li>
                <li>
                  <span>BTC concentration</span>
                  <strong className="cd-mono">≤ 42 / 100</strong>
                </li>
                <li>
                  <span>Price freshness</span>
                  <strong className="cd-mono">≤ 5,000 ms</strong>
                </li>
                <li>
                  <span>BUY inhibit</span>
                  <StateChip tone="ok">OFF</StateChip>
                </li>
              </ul>
            </Panel>
          </div>
          <Panel title="Lifecycle actions" eyebrow="Effects on sealed plans">
            <div className="cd-grid-3">
              <article>
                <h3>Publish policy</h3>
                <p>
                  Invalidates an unmarked sealed plan. A marked attempt remains in flight and cannot
                  be dispatched again.
                </p>
                <button className="cd-button cd-button--quiet" type="button" disabled>
                  Publish revision
                </button>
              </article>
              <article>
                <h3>Revoke credential</h3>
                <p>
                  Stops future proposals. It does not cancel an order the venue may already have
                  accepted.
                </p>
                <button className="cd-button cd-button--quiet" type="button" disabled>
                  Review revoke
                </button>
              </article>
              <article>
                <h3>Halt pool</h3>
                <p>
                  Blocks new dispatch. Existing UNKNOWN liability stays reserved until evidence
                  permits transition.
                </p>
                <button className="cd-button cd-button--quiet" type="button" disabled>
                  Review halt
                </button>
              </article>
            </div>
          </Panel>
          <Panel title="Proposal credentials" eyebrow="Secret references only">
            <ul className="cd-list">
              <li>
                <div>
                  <strong>Reserve ladder</strong>
                  <small className="cd-mono">credref://proposal/alpha/4 · intent.propose</small>
                </div>
                <StateChip tone="ok">ACTIVE</StateChip>
              </li>
              <li>
                <div>
                  <strong>Volatility sleeve</strong>
                  <small className="cd-mono">credref://proposal/beta/2 · intent.propose</small>
                </div>
                <StateChip tone="ok">ACTIVE</StateChip>
              </li>
              <li>
                <div>
                  <strong>Protective unwind</strong>
                  <small className="cd-mono">credref://proposal/gamma/1 · revoked 2026-09-10</small>
                </div>
                <StateChip tone="danger">REVOKED</StateChip>
              </li>
            </ul>
          </Panel>
        </div>
      </PreviewGate>
    </div>
  );
}
