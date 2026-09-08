import {
  EvidenceLink,
  PageIntro,
  Panel,
  PreviewGate,
  Quantity,
  StateChip,
  TableRegion,
} from '../../components/Console';
import { Icon } from '../../components/Icons';
import { CAPITAL } from '../../lib/preview-data';

export default function CapitalPage() {
  return (
    <div className="cd-stack">
      <PageIntro
        eyebrow="Ownership ledger"
        title="Capital is a claim, with a source."
        summary="Every amount stays in its own asset. Available, reserved, HOUSE and quarantined claims reconcile to the observed account quantity."
        action={
          <a className="cd-button cd-button--quiet" href="/strategies">
            Inspect strategies <Icon name="arrow" width="16" height="16" />
          </a>
        }
      />
      <PreviewGate>
        <div className="cd-stack">
          <Panel
            title="Per-asset ownership"
            eyebrow="Baseline epoch 12"
            action={<StateChip tone="ok">SOURCE COMPLETE</StateChip>}
          >
            <TableRegion label="Per-asset claim reconciliation">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th data-align="right">Exchange total</th>
                    <th data-align="right">Available</th>
                    <th data-align="right">Reserved</th>
                    <th data-align="right">HOUSE</th>
                    <th data-align="right">Quarantined</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {CAPITAL.map((row) => (
                    <tr key={row.asset}>
                      <td>
                        <strong>{row.asset}</strong>
                        <small>8 decimal display precision</small>
                      </td>
                      <td data-align="right">
                        <Quantity amount={row.account} asset={row.asset} />
                      </td>
                      <td data-align="right">
                        <Quantity amount={row.available} asset={row.asset} />
                      </td>
                      <td data-align="right">
                        <Quantity amount={row.reserved} asset={row.asset} />
                      </td>
                      <td data-align="right">
                        <Quantity amount={row.house} asset={row.asset} />
                      </td>
                      <td data-align="right">
                        <Quantity amount={row.quarantined} asset={row.asset} />
                      </td>
                      <td>
                        <StateChip tone={row.status === 'RECONCILED' ? 'ok' : 'danger'}>
                          {row.status}
                        </StateChip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
            <p style={{ margin: 'var(--cd-s3) 0 0', color: 'var(--cd-ink-muted)', fontSize: 13 }}>
              No cross-asset total is shown. Fiat estimates cannot create spendable claims.
            </p>
          </Panel>

          <div className="cd-grid">
            <Panel title="USDT claim composition" eyebrow="Internal assignment">
              <ul className="cd-list">
                <li>
                  <div>
                    <strong>Reserve ladder</strong>
                    <small>Owner mandate v4 · available</small>
                  </div>
                  <Quantity amount="8,250.00000000" asset="USDT" />
                </li>
                <li>
                  <div>
                    <strong>Volatility sleeve</strong>
                    <small>Owner mandate v2 · available</small>
                  </div>
                  <Quantity amount="4,500.00000000" asset="USDT" />
                </li>
                <li>
                  <div>
                    <strong>Plan CD-P1042</strong>
                    <small>Reservation stays held while outcome is unknown</small>
                  </div>
                  <Quantity amount="4,500.00000000" asset="USDT" />
                </li>
                <li>
                  <div>
                    <strong>HOUSE</strong>
                    <small>Unassigned owner claim · not agent spendable</small>
                  </div>
                  <Quantity amount="1,200.00000000" asset="USDT" />
                </li>
              </ul>
            </Panel>
            <Panel
              title="Fee-only drift"
              eyebrow="BNB incident"
              action={<EvidenceLink href="/orders">Incident CD-I008</EvidenceLink>}
            >
              <div className="cd-callout cd-callout--danger">
                <Icon name="alert" width="20" height="20" />
                <div>
                  <strong>0.00243719 BNB is quarantined</strong>
                  <p>
                    Observed account total exceeds attributed claims. The difference is visible,
                    non-spendable and linked to its source records.
                  </p>
                </div>
              </div>
              <ul className="cd-list" style={{ marginTop: 'var(--cd-s4)' }}>
                <li>
                  <span>Last complete account snapshot</span>
                  <span className="cd-mono">12:42:20.181Z</span>
                </li>
                <li>
                  <span>Independent reconciliation</span>
                  <StateChip tone="danger">MISMATCH</StateChip>
                </li>
                <li>
                  <span>Allowed next action</span>
                  <strong>Inspect source</strong>
                </li>
              </ul>
            </Panel>
          </div>
        </div>
      </PreviewGate>
    </div>
  );
}
