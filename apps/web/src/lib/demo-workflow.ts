/** Presentation-only model. It has no adapter, transport, credentials, or operational store. */
export type DemoPhase = 'conflict' | 'plan' | 'approved' | 'partial' | 'unknown' | 'reconciled';
export type DemoAction =
  'defer' | 'approve' | 'partial' | 'timeout' | 'restart' | 'reconcile' | 'reset';
export interface DemoState {
  readonly phase: DemoPhase;
  readonly reservedQuoteAtoms: bigint;
  readonly simulatedAttempts: number;
  readonly claimsFinalized: boolean;
  readonly events: readonly string[];
}

// TEST-PLAN §4, QUOTE_FEE_FIXTURE_V1. This is not a current Binance fee schedule.
export const DEMO_FILL = {
  allocations: [
    {
      strategy: 'Momentum',
      targetAtoms: 1000000n,
      baseAtoms: 1000000n,
      quoteAtoms: 199000000n,
      feeQuoteAtoms: 199000n,
    },
    {
      strategy: 'Accumulation',
      targetAtoms: 2000000n,
      baseAtoms: 1000000n,
      quoteAtoms: 199000000n,
      feeQuoteAtoms: 199000n,
    },
  ],
} as const;

export function initialDemo(): DemoState {
  return {
    phase: 'conflict',
    reservedQuoteAtoms: 0n,
    simulatedAttempts: 0,
    claimsFinalized: false,
    events: ['Simulation loaded: opposing BTC targets block planning. No venue requests.'],
  };
}

export function demoTransition(state: DemoState, action: DemoAction): DemoState {
  if (action === 'reset') return initialDemo();
  const record = (patch: Partial<DemoState>, event: string): DemoState => ({
    ...state,
    ...patch,
    events: [...state.events, event],
  });
  if (action === 'defer' && state.phase === 'conflict') {
    return record(
      { phase: 'plan' },
      'Demo owner defers Protective unwind. Its later revisions remain deferred.',
    );
  }
  if (action === 'approve' && state.phase === 'plan') {
    return record(
      { phase: 'approved', reservedQuoteAtoms: 600600000n },
      'Demo approval freezes FIFO: Momentum first, Accumulation second. 600.600 USDT reserved in the scenario.',
    );
  }
  if ((action === 'partial' || action === 'timeout') && state.phase === 'approved') {
    return record(
      { phase: action === 'partial' ? 'partial' : 'unknown', simulatedAttempts: 1 },
      action === 'partial'
        ? 'Fixture response: 0.02000000 BTC gross fill; 0.01000000 BTC expires. Complete evidence is still required.'
        : 'Fault simulation: response lost after dispatch marker. UNKNOWN keeps the full reserve held.',
    );
  }
  if (action === 'restart' && state.phase === 'unknown') {
    return record(
      {},
      'Simulated process restart recovers the same marker. No resend; 600.600 USDT stays reserved.',
    );
  }
  if (action === 'reconcile' && (state.phase === 'unknown' || state.phase === 'partial')) {
    return record(
      { phase: 'reconciled', reservedQuoteAtoms: 0n, claimsFinalized: true },
      'Complete fixture evidence loaded: terminal IOC + fill + quote commission. FIFO allocations finalize; residual reservations release.',
    );
  }
  return state;
}

export function demoQuote(atoms: bigint): string {
  return `${atoms / 1000000n}.${(atoms % 1000000n).toString().padStart(6, '0').slice(0, 3)}`;
}
