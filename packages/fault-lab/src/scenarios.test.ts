import { describe, expect, it } from 'vitest';
import { SCENARIOS, runDeterministicScenario } from './scenarios.js';

describe('independent deterministic fault scenarios', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario} reports only proven passing invariants`, () => {
      const result = runDeterministicScenario(scenario);
      expect(result.evidenceClass).toBe('DETERMINISTIC_FIXTURE');
      expect(result.outcome).toBe('PASS');
      expect(result.invariants.length).toBeGreaterThan(0);
      expect(result.invariants.every((invariant) => invariant.pass)).toBe(true);
    });
  }

  it('response loss and crash after marker count exactly one downstream placement', () => {
    for (const scenario of ['response-loss', 'crash-after-marker'] as const) {
      const result = runDeterministicScenario(scenario);
      expect(result.invariants[0]?.evidence['downstreamAttempts']).toBe('1');
      expect(result.invariants[1]?.evidence['reservation']).toBe('HELD');
    }
  });
});
