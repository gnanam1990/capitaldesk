import {
  OperationalState,
  PageIntro,
  PreviewGate,
  Quantity,
  StateChip,
} from '../../components/Console';

export default function UiStatesPage() {
  return (
    <div className="cd-stack">
      <PageIntro
        eyebrow="Component evidence"
        title="Rare states, shown truthfully."
        summary="This isolated development route exercises long values, absence, degraded sources, denied actions, reset epochs and unsupported execution without entering production routes."
      />
      <PreviewGate>
        <div className="cd-stack">
          <div className="cd-grid-3">
            <OperationalState
              kind="pending"
              title="Evidence is still arriving"
              detail="Three of four fill pages are complete. Strategy credit stays provisional and non-spendable."
              action={<StateChip tone="unknown">EVIDENCE INCOMPLETE</StateChip>}
            />
            <OperationalState
              kind="degraded"
              title="Last observation is stale"
              detail="The last complete account snapshot is 9m 42s old. Dependent approval actions are disabled."
              action={
                <button className="cd-button cd-button--quiet" type="button" disabled>
                  Approval unavailable
                </button>
              }
            />
            <OperationalState
              kind="empty"
              title="No baseline exists"
              detail="Connect an authorized read source and reconcile the first complete account snapshot before assigning claims."
              action={
                <button className="cd-button cd-button--quiet" type="button" disabled>
                  Setup unavailable
                </button>
              }
            />
            <OperationalState
              kind="denied"
              title="Owner authority required"
              detail="Proposal credentials cannot publish policy, approve a plan, halt a pool or dispatch an order."
              action={<StateChip tone="danger">SCOPE DENIED</StateChip>}
            />
            <OperationalState
              kind="denied"
              title="Execution mode unsupported"
              detail="This host cannot bind native confirmation to the sealed child order. The account remains observation-only."
              action={<StateChip tone="neutral">OBSERVATION ONLY</StateChip>}
            />
            <OperationalState
              kind="degraded"
              title="Epoch 11 is historical"
              detail="A testnet reset invalidated its baseline. Old evidence stays inspectable and cannot become current funds."
              action={<StateChip tone="warn">EPOCH INVALID</StateChip>}
            />
          </div>
          <article className="cd-panel">
            <span className="cd-kicker">Long value stress case</span>
            <h2 style={{ marginTop: 'var(--cd-s2)' }}>No clipping at 200% zoom</h2>
            <p className="cd-mono" style={{ overflowWrap: 'anywhere' }}>
              01J7QZ7A2EN9PSW1GX3KHF4R8Y-venue-correlation-938da64f7b861d0f
            </p>
            <Quantity amount="9,999,999,999,999,999.123456789012345678" asset="USDT" />
          </article>
        </div>
      </PreviewGate>
    </div>
  );
}
