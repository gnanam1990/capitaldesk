import Link from 'next/link';
import { previewMode } from '../../lib/preview-data';
import {
  FactList,
  PageIntro,
  Panel,
  PreviewGate,
  Quantity,
  StateChip,
  TableRegion,
} from '../../components/Console';
import { Icon } from '../../components/Icons';
import { PLAN_DIGEST, PLAN_ID } from '../../lib/preview-data';

const CANONICAL = `{
  "accountEpoch": 12,
  "allocationPolicy": "FIFO_V1",
  "childOrder": {
    "symbol": "BTCUSDT",
    "side": "BUY",
    "type": "LIMIT",
    "timeInForce": "IOC",
    "baseAtoms": "6750000",
    "priceAtoms": "6711000000000"
  },
  "feePolicyVersion": 3,
  "planId": "${PLAN_ID}",
  "policyVersion": 4,
  "submissionDeadlineAt": "2026-09-08T12:47:00.000Z"
}`;

export default function PlansPage() {
  return (
    <div className="cd-stack">
      <PageIntro
        eyebrow="Immutable review"
        title="Approve exactly what can be sent."
        summary="The order, limits, source revisions, reservations and FIFO allocation are bound into one digest. Any material change requires a fresh review."
        action={
          previewMode(process.env) ? (
            <Link className="cd-button" href="/demo">
              Try the approval demo
            </Link>
          ) : undefined
        }
      />
      <PreviewGate>
        <div className="cd-stack">
          <div className="cd-callout">
            <Icon name="alert" width="20" height="20" />
            <div>
              <strong>Explore the plan, then try a simulated approval</strong>
              <p>
                This sample binds the order limits and FIFO allocation into one review. The guided
                demo lets you explore the decision and its outcome using simulated records only.
              </p>
            </div>
          </div>
          <div className="cd-grid">
            <Panel
              title="BTCUSDT · LIMIT IOC"
              eyebrow={PLAN_ID}
              action={<StateChip tone="warn">AWAITING APPROVAL</StateChip>}
            >
              <FactList
                facts={[
                  ['Side', <strong key="side">BUY</strong>],
                  ['Gross requested', <Quantity key="gross" amount="0.06750000" asset="BTC" />],
                  [
                    'Limit price',
                    <Quantity key="limit" amount="67,110.00000000" asset="USDT/BTC" />,
                  ],
                  [
                    'Maximum quote debit',
                    <Quantity key="debit" amount="4,529.92500000" asset="USDT" />,
                  ],
                  ['Fee reserve', <Quantity key="fee" amount="4.52992500" asset="USDT" />],
                  [
                    'Residual after fee',
                    <Quantity key="residual" amount="0.00006750" asset="BTC" />,
                  ],
                ]}
              />
              <div style={{ marginTop: 'var(--cd-s4)' }}>
                <span className="cd-kicker">Strictest limit</span>
                <p style={{ margin: 'var(--cd-s1) 0 0' }}>
                  Volatility sleeve constrains the combined BUY to 67,110.00000000 USDT/BTC. An IOC
                  may leave the remainder unfilled.
                </p>
              </div>
            </Panel>
            <Panel title="Time & source binding" eyebrow="All clocks explicit">
              <ul className="cd-list">
                <li>
                  <div>
                    <strong>Plan expiry</strong>
                    <small>After this instant approval is invalid</small>
                  </div>
                  <span className="cd-mono">12:49:00Z</span>
                </li>
                <li>
                  <div>
                    <strong>Submission deadline</strong>
                    <small>Latest instant the sealed child may be sent</small>
                  </div>
                  <span className="cd-mono">12:47:00Z</span>
                </li>
                <li>
                  <div>
                    <strong>Owner session expiry</strong>
                    <small>Separate local authorization fact</small>
                  </div>
                  <span className="cd-mono">13:12:00Z</span>
                </li>
                <li>
                  <div>
                    <strong>Native confirmation</strong>
                    <small>Required after local approval in managed mode</small>
                  </div>
                  <StateChip tone="neutral">NOT STARTED</StateChip>
                </li>
              </ul>
            </Panel>
          </div>
          <Panel title="Fixed FIFO allocation" eyebrow="Allocation policy FIFO_V1">
            <TableRegion label="Plan participant FIFO allocation">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>Sequence</th>
                    <th>Strategy / intent</th>
                    <th data-align="right">Requested gross</th>
                    <th data-align="right">Max quote debit</th>
                    <th data-align="right">Fee cap</th>
                    <th>Source revision</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="cd-mono">0001040</td>
                    <td>
                      <strong>Reserve ladder</strong>
                      <small>intent_8d98a41c · r18</small>
                    </td>
                    <td data-align="right">
                      <Quantity amount="0.04550000" asset="BTC" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="3,053.50500000" asset="USDT" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="3.05350500" asset="USDT" />
                    </td>
                    <td className="cd-mono">ledger:844</td>
                  </tr>
                  <tr>
                    <td className="cd-mono">0001041</td>
                    <td>
                      <strong>Volatility sleeve</strong>
                      <small>intent_a16f52ee · r07</small>
                    </td>
                    <td data-align="right">
                      <Quantity amount="0.02200000" asset="BTC" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="1,476.42000000" asset="USDT" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="1.47642000" asset="USDT" />
                    </td>
                    <td className="cd-mono">ledger:844</td>
                  </tr>
                </tbody>
              </table>
            </TableRegion>
          </Panel>
          <div className="cd-split">
            <Panel title="Hypothetical partial fill" eyebrow="Explanation only">
              <p style={{ color: 'var(--cd-ink-muted)' }}>
                If the venue returns exactly <Quantity amount="0.05000000" asset="BTC" />, the first
                participant receives its full 0.04550000 BTC gross allocation; the second receives
                0.00450000 BTC. Actual allocation stays unknown until complete fill evidence.
              </p>
              <div className="cd-progress" aria-label="Hypothetical fill 74 percent">
                <span style={{ width: '74%' }} />
              </div>
            </Panel>
            <Panel title="Bound digest" eyebrow="Technical evidence">
              <p className="cd-mono" style={{ overflowWrap: 'anywhere', fontSize: 12 }}>
                {PLAN_DIGEST}
              </p>
              <details>
                <summary>Canonical payload</summary>
                <pre className="cd-code">{CANONICAL}</pre>
              </details>
            </Panel>
          </div>
        </div>
      </PreviewGate>
    </div>
  );
}
