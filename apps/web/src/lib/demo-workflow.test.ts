import { describe, expect, it } from 'vitest';
import { demoTransition, initialDemo, DEMO_FILL } from './demo-workflow.js';

describe('isolated presentation simulation', () => {
  it('cannot approve or create a simulated dispatch while opposing targets conflict', () => {
    for (const action of ['approve', 'partial', 'timeout', 'reconcile'] as const) {
      expect(demoTransition(initialDemo(), action)).toEqual(initialDemo());
    }
  });

  it('freezes a reserve only after review and allows one simulated dispatch', () => {
    const plan = demoTransition(initialDemo(), 'defer');
    expect(plan.phase).toBe('plan');
    expect(plan.reservedQuoteAtoms).toBe(0n);
    const approved = demoTransition(plan, 'approve');
    expect(approved.reservedQuoteAtoms).toBe(600600000n);
    const partial = demoTransition(approved, 'partial');
    expect(partial.simulatedAttempts).toBe(1);
    expect(partial.reservedQuoteAtoms).toBe(600600000n);
    expect(partial.claimsFinalized).toBe(false);
    expect(demoTransition(partial, 'partial')).toEqual(partial);
    expect(demoTransition(partial, 'approve')).toEqual(partial);
  });

  it('keeps UNKNOWN capital held across restart and rejects a resend', () => {
    const approved = demoTransition(demoTransition(initialDemo(), 'defer'), 'approve');
    const unknown = demoTransition(approved, 'timeout');
    const restarted = demoTransition(unknown, 'restart');
    expect(restarted.phase).toBe('unknown');
    expect(restarted.simulatedAttempts).toBe(1);
    expect(restarted.reservedQuoteAtoms).toBe(600600000n);
    expect(restarted.claimsFinalized).toBe(false);
    expect(demoTransition(restarted, 'partial')).toEqual(restarted);
    expect(demoTransition(restarted, 'timeout')).toEqual(restarted);
  });

  it.each(['partial', 'timeout'] as const)(
    'finalizes only after complete fixture evidence: %s',
    (outcome) => {
      const approved = demoTransition(demoTransition(initialDemo(), 'defer'), 'approve');
      const reconciled = demoTransition(demoTransition(approved, outcome), 'reconcile');
      expect(reconciled.phase).toBe('reconciled');
      expect(reconciled.claimsFinalized).toBe(true);
      expect(reconciled.reservedQuoteAtoms).toBe(0n);
      expect(reconciled.simulatedAttempts).toBe(1);
      expect(demoTransition(reconciled, 'reconcile')).toEqual(reconciled);
    },
  );

  it('preserves golden fixture totals per asset and FIFO unmet target', () => {
    expect(DEMO_FILL.allocations.reduce((sum, row) => sum + row.baseAtoms, 0n)).toBe(2000000n);
    expect(DEMO_FILL.allocations.reduce((sum, row) => sum + row.quoteAtoms, 0n)).toBe(398000000n);
    expect(DEMO_FILL.allocations.reduce((sum, row) => sum + row.feeQuoteAtoms, 0n)).toBe(398000n);
    expect(DEMO_FILL.allocations.map((row) => row.targetAtoms - row.baseAtoms)).toEqual([
      0n,
      1000000n,
    ]);
  });

  it('starts a new fictional scenario without retaining claims or a dispatch', () => {
    const approved = demoTransition(demoTransition(initialDemo(), 'defer'), 'approve');
    expect(demoTransition(demoTransition(approved, 'timeout'), 'reset')).toEqual(initialDemo());
  });
});
