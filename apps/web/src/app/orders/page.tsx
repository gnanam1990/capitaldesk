import {
  EvidenceLink,
  FactList,
  PageIntro,
  Panel,
  PreviewGate,
  Quantity,
  StateChip,
  TableRegion,
  Timeline,
} from '../../components/Console';
import { Icon } from '../../components/Icons';

export default function OrdersPage() {
  return (
    <div className="cd-stack">
      <PageIntro
        eyebrow="Recovery workbench"
        title="Known, held and missing — without guessing."
        summary="Transport, venue order and accounting each keep their own state. Recovery reads evidence; it never creates a replacement order."
        action={
          <button className="cd-button cd-button--quiet" type="button" disabled>
            Recheck status
          </button>
        }
      />
      <PreviewGate>
        <div className="cd-stack">
          <div className="cd-callout cd-callout--unknown">
            <Icon name="alert" width="20" height="20" />
            <div>
              <strong>The exchange may have accepted this order.</strong>
              <p>
                Capital stays reserved while status is checked. There is no safe resend and no
                generic retry action.
              </p>
            </div>
          </div>
          <div className="cd-stats">
            <article className="cd-stat">
              <div className="cd-stat-top">
                <span>Transport</span>
              </div>
              <div style={{ marginTop: 'var(--cd-s3)' }}>
                <StateChip tone="unknown">RESPONSE LOST</StateChip>
              </div>
              <p>Dispatch marker committed before send</p>
            </article>
            <article className="cd-stat">
              <div className="cd-stat-top">
                <span>Venue order</span>
              </div>
              <div style={{ marginTop: 'var(--cd-s3)' }}>
                <StateChip tone="unknown">UNKNOWN</StateChip>
              </div>
              <p>Awaiting authoritative query by client ID</p>
            </article>
            <article className="cd-stat">
              <div className="cd-stat-top">
                <span>Accounting</span>
              </div>
              <div style={{ marginTop: 'var(--cd-s3)' }}>
                <StateChip tone="warn">RESERVED</StateChip>
              </div>
              <p>Credit remains non-spendable</p>
            </article>
            <StatHeld />
          </div>
          <div className="cd-grid">
            <Panel title="Incident CD-I009" eyebrow="Correlation 01J7QY0A9H7K2">
              <Timeline
                items={[
                  {
                    title: 'Owner approval recorded',
                    detail: 'Digest and source revisions bound to plan CD-P1042.',
                    time: '12:38:58.020Z',
                    tone: 'ok',
                    icon: 'check',
                  },
                  {
                    title: 'Dispatch marker committed',
                    detail: 'Client order identity persisted before the network boundary.',
                    time: '12:39:04.100Z',
                    tone: 'ok',
                    icon: 'shield',
                  },
                  {
                    title: 'Response not observed',
                    detail: 'Connection ended without authoritative acceptance or rejection.',
                    time: '12:39:04.912Z',
                    tone: 'unknown',
                    icon: 'alert',
                  },
                  {
                    title: 'Recovery read scheduled',
                    detail: 'Last query found no complete order universe; absence is not proven.',
                    time: '12:42:18.503Z',
                    tone: 'warn',
                  },
                ]}
              />
            </Panel>
            <Panel title="Safe next step" eyebrow="Read-only recovery">
              <FactList
                facts={[
                  ['Evidence awaited', 'Order query + trade range coverage'],
                  ['Last authoritative fact', 'Dispatch marker committed'],
                  ['Responsible role', 'VENUE_READ worker'],
                  ['Held assets', <Quantity key="held" amount="4,504.50000000" asset="USDT" />],
                  [
                    'Resend',
                    <StateChip key="resend" tone="danger">
                      PROHIBITED
                    </StateChip>,
                  ],
                  ['Owner resolution', 'Unavailable until evidence supports one'],
                ]}
              />
              <button
                className="cd-button cd-button--quiet"
                style={{ marginTop: 'var(--cd-s4)' }}
                type="button"
                disabled
              >
                Request read-only recheck
              </button>
            </Panel>
          </div>
          <Panel
            title="Earlier partial IOC"
            eyebrow="Order CD-O1041"
            action={<EvidenceLink>Open complete evidence</EvidenceLink>}
          >
            <TableRegion label="Partial fill allocation">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th data-align="right">Requested</th>
                    <th data-align="right">Gross fill</th>
                    <th data-align="right">Net ownership</th>
                    <th data-align="right">Actual fee</th>
                    <th data-align="right">Unmet target</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Reserve ladder</td>
                    <td data-align="right">
                      <Quantity amount="0.04550000" asset="BTC" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="0.04550000" asset="BTC" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="0.04545450" asset="BTC" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="0.00004550" asset="BTC" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="0.00004550" asset="BTC" />
                    </td>
                  </tr>
                  <tr>
                    <td>Volatility sleeve</td>
                    <td data-align="right">
                      <Quantity amount="0.02200000" asset="BTC" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="0.00640000" asset="BTC" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="0.00639360" asset="BTC" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="0.00000640" asset="BTC" />
                    </td>
                    <td data-align="right">
                      <Quantity amount="0.01560640" asset="BTC" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </TableRegion>
          </Panel>
        </div>
      </PreviewGate>
    </div>
  );
}

function StatHeld() {
  return (
    <article className="cd-stat">
      <div className="cd-stat-top">
        <span>Held liability</span>
        <span className="cd-stat-dot cd-stat-dot--unknown" aria-hidden="true" />
      </div>
      <strong className="cd-quantity">
        4,504.50000000 <small>USDT</small>
      </strong>
      <p>Quote cap plus bounded fee reserve</p>
    </article>
  );
}
