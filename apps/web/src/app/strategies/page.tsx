import { PageIntro, Panel, PreviewGate, Quantity, StateChip } from '../../components/Console';

const STRATEGIES = [
  {
    name: 'Reserve ladder',
    id: 'strategy_alpha_3b8a4d90c7742af1',
    state: 'ACTIVE',
    target: '0.32000000',
    claim: '0.21000000',
    reserved: '0.06450000',
    token: 'Active · last used 4m ago',
  },
  {
    name: 'Volatility sleeve',
    id: 'strategy_beta_800e91a2ef019d72',
    state: 'ACTIVE',
    target: '0.13500000',
    claim: '0.06000000',
    reserved: '0.00000000',
    token: 'Active · last used 12m ago',
  },
  {
    name: 'Protective unwind',
    id: 'strategy_gamma_c11d209ea14c320f',
    state: 'DEFERRED',
    target: '0.02000000',
    claim: '0.05000000',
    reserved: '0.00000000',
    token: 'Revoked · 10 Sep 2026',
  },
] as const;

export default function StrategiesPage() {
  return (
    <div className="cd-stack">
      <PageIntro
        eyebrow="Proposal identities"
        title="Strategies can propose. The owner controls capital."
        summary="Claims are internal ownership in one venue account. Proposal credentials cannot approve, dispatch, sign or read secrets."
      />
      <PreviewGate>
        <div className="cd-grid-3">
          {STRATEGIES.map((strategy) => (
            <Panel
              key={strategy.id}
              title={strategy.name}
              eyebrow={strategy.id}
              action={
                <StateChip tone={strategy.state === 'ACTIVE' ? 'ok' : 'warn'}>
                  {strategy.state}
                </StateChip>
              }
            >
              <ul className="cd-list">
                <li>
                  <span>Selected symbol</span>
                  <strong className="cd-mono">BTCUSDT</strong>
                </li>
                <li>
                  <span>Absolute target · r18</span>
                  <Quantity amount={strategy.target} asset="BTC" />
                </li>
                <li>
                  <span>Confirmed claim</span>
                  <Quantity amount={strategy.claim} asset="BTC" />
                </li>
                <li>
                  <span>Reserved</span>
                  <Quantity amount={strategy.reserved} asset="BTC" />
                </li>
                <li>
                  <div>
                    <span>Proposal credential</span>
                    <small>Secret value is never displayed</small>
                  </div>
                  <span>{strategy.token}</span>
                </li>
              </ul>
            </Panel>
          ))}
        </div>
      </PreviewGate>
    </div>
  );
}
