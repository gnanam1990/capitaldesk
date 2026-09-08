import {
  PageIntro,
  Panel,
  PreviewGate,
  Quantity,
  StateChip,
  TableRegion,
} from '../../components/Console';
import { Icon } from '../../components/Icons';
import { INTENTS } from '../../lib/preview-data';

export default function IntentsPage() {
  return (
    <div className="cd-stack">
      <PageIntro
        eyebrow="Target coordination"
        title="Three intents. Two directions. One explicit conflict."
        summary="Targets are absolute desired ownership, not instructions to buy the same delta again. Revisions and source age remain inspectable."
        action={
          <button className="cd-button cd-button--quiet" type="button" disabled>
            New intent unavailable
          </button>
        }
      />
      <PreviewGate>
        <div className="cd-stack">
          <div className="cd-callout">
            <Icon name="alert" width="20" height="20" />
            <div>
              <strong>Opposing proposal requires an owner decision</strong>
              <p>
                Two strategies want to increase BTC while Protective unwind wants to reduce it.
                CapitalDesk will not net these intentions or invent an internal transfer.
              </p>
            </div>
          </div>
          <Panel
            title="Live intent queue"
            eyebrow="Price snapshot age 1.2s"
            action={<StateChip tone="warn">1 CONFLICT</StateChip>}
          >
            <TableRegion label="Intent revisions">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th data-align="right">Target</th>
                    <th data-align="right">Owned</th>
                    <th data-align="right">Committed</th>
                    <th data-align="right">Remaining delta</th>
                    <th>Constraint</th>
                    <th>Revision</th>
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
                      <td data-align="right">
                        <Quantity amount={intent.target} asset="BTC" />
                      </td>
                      <td data-align="right">
                        <Quantity amount={intent.owned} asset="BTC" />
                      </td>
                      <td data-align="right">
                        <Quantity amount={intent.committed} asset="BTC" />
                      </td>
                      <td data-align="right">
                        <Quantity amount={intent.delta} asset="BTC" />
                      </td>
                      <td className="cd-mono">{intent.limit}</td>
                      <td className="cd-mono">{intent.revision}</td>
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
          <div className="cd-grid">
            <Panel title="Permitted resolution" eyebrow="Owner authority">
              <ul className="cd-list">
                <li>
                  <div>
                    <strong>Defer Protective unwind</strong>
                    <small>
                      Deferral binds the strategy target. Newer revisions remain deferred until
                      owner reinstatement.
                    </small>
                  </div>
                  <button className="cd-button cd-button--quiet" type="button" disabled>
                    Defer target
                  </button>
                </li>
                <li>
                  <div>
                    <strong>Revise one target</strong>
                    <small>
                      Open a fresh strategy revision. The existing revision remains historical
                      evidence.
                    </small>
                  </div>
                  <button className="cd-button cd-button--quiet" type="button" disabled>
                    Open revision
                  </button>
                </li>
              </ul>
            </Panel>
            <Panel title="Why no plan exists" eyebrow="Reason codes">
              <ul className="cd-list">
                <li>
                  <span>Primary reason</span>
                  <strong className="cd-mono">OPPOSITE_SIDE_CONFLICT</strong>
                </li>
                <li>
                  <span>Affected symbol</span>
                  <strong className="cd-mono">BTCUSDT</strong>
                </li>
                <li>
                  <span>Queue sequence</span>
                  <strong className="cd-mono">0001042</strong>
                </li>
                <li>
                  <span>Auto-netting</span>
                  <StateChip tone="neutral">DISALLOWED</StateChip>
                </li>
              </ul>
            </Panel>
          </div>
        </div>
      </PreviewGate>
    </div>
  );
}
