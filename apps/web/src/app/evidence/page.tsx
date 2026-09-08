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
import { ACCOUNT_ID, PLAN_DIGEST } from '../../lib/preview-data';

const MANIFEST = `manifestVersion: capitaldesk-evidence/v1
environment: testnet
accountEpoch: 12
accountKey: ${ACCOUNT_ID}
coverage: COMPLETE_WITH_UNRESOLVED_ITEMS
records: 184
unresolved:
  - incidentId: CD-I009
    state: UNKNOWN
digest: sha256:ee733e95d2fa7d363e0a9e50ab36e30e3486220cd94bb94b9baf040d251f04ac`;

export default function EvidencePage() {
  return (
    <div className="cd-stack">
      <PageIntro
        eyebrow="Independent proof"
        title="Evidence that says exactly what it proves."
        summary="Exports preserve exact decimal text, account epoch, source coverage and unresolved liabilities. Digest integrity is not a venue signature."
        action={
          <button className="cd-button" type="button" disabled>
            Prepare export
          </button>
        }
      />
      <PreviewGate>
        <div className="cd-stack">
          <div className="cd-stats">
            <article className="cd-stat">
              <div className="cd-stat-top">
                <span>Journal records</span>
              </div>
              <strong className="cd-quantity">184</strong>
              <p>Append-only entries in epoch 12</p>
            </article>
            <article className="cd-stat">
              <div className="cd-stat-top">
                <span>Coverage</span>
              </div>
              <div style={{ marginTop: 'var(--cd-s3)' }}>
                <StateChip tone="warn">UNRESOLVED INCLUDED</StateChip>
              </div>
              <p>Incident CD-I009 remains open</p>
            </article>
            <article className="cd-stat">
              <div className="cd-stat-top">
                <span>Verifier</span>
              </div>
              <div style={{ marginTop: 'var(--cd-s3)' }}>
                <StateChip tone="ok">DIGEST VALID</StateChip>
              </div>
              <p>Content has not changed since export</p>
            </article>
            <article className="cd-stat">
              <div className="cd-stat-top">
                <span>Venue signature</span>
              </div>
              <div style={{ marginTop: 'var(--cd-s3)' }}>
                <StateChip tone="neutral">NOT PROVIDED</StateChip>
              </div>
              <p>Digest does not imply venue attestation</p>
            </article>
          </div>
          <div className="cd-grid">
            <Panel title="Manifest verifier" eyebrow="capitaldesk-evidence/v1">
              <FactList
                facts={[
                  [
                    'Filename',
                    <span className="cd-mono" key="file">
                      capitaldesk-testnet-epoch12-20260908T124500Z.json
                    </span>,
                  ],
                  [
                    'Build',
                    <span className="cd-mono" key="build">
                      f663f0e
                    </span>,
                  ],
                  ['Records', '184'],
                  ['Coverage', 'Complete, with unresolved items'],
                  [
                    'Payload digest',
                    <span className="cd-mono" key="digest">
                      {PLAN_DIGEST}
                    </span>,
                  ],
                  [
                    'Secret scan',
                    <StateChip key="redacted" tone="ok">
                      REDACTED
                    </StateChip>,
                  ],
                ]}
              />
              <div className="cd-callout" style={{ marginTop: 'var(--cd-s4)' }}>
                <Icon name="alert" width="20" height="20" />
                <div>
                  <strong>One unresolved liability is included</strong>
                  <p>
                    The export completed. Incident CD-I009 did not resolve and its USDT reservation
                    remains held.
                  </p>
                </div>
              </div>
            </Panel>
            <Panel title="Structured manifest" eyebrow="Fixture preview">
              <pre className="cd-code">{MANIFEST}</pre>
            </Panel>
          </div>
          <Panel title="USDT ledger journal" eyebrow="Balanced by asset">
            <TableRegion label="USDT append-only ledger journal">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>Revision</th>
                    <th>UTC time</th>
                    <th>Reference</th>
                    <th>Account</th>
                    <th data-align="right">Debit</th>
                    <th data-align="right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="cd-mono">844</td>
                    <td className="cd-mono">12:38:50.021Z</td>
                    <td>Plan reservation</td>
                    <td className="cd-mono">strategy:alpha:reserved</td>
                    <td data-align="right">
                      <Quantity amount="3,003.00000000" asset="USDT" />
                    </td>
                    <td data-align="right">—</td>
                  </tr>
                  <tr>
                    <td className="cd-mono">844</td>
                    <td className="cd-mono">12:38:50.021Z</td>
                    <td>Plan reservation</td>
                    <td className="cd-mono">strategy:alpha:available</td>
                    <td data-align="right">—</td>
                    <td data-align="right">
                      <Quantity amount="3,003.00000000" asset="USDT" />
                    </td>
                  </tr>
                  <tr>
                    <td className="cd-mono">845</td>
                    <td className="cd-mono">12:38:50.027Z</td>
                    <td>Fee reserve</td>
                    <td className="cd-mono">strategy:alpha:reserved</td>
                    <td data-align="right">
                      <Quantity amount="3.00300000" asset="USDT" />
                    </td>
                    <td data-align="right">—</td>
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
