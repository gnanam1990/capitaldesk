import { describe, expect, it } from 'vitest';
import { CAPITAL, INTENTS, isCanonicalDecimal, previewMode } from './preview-data.js';

describe('labelled UI preview boundary', () => {
  it('is opt-in and never enabled by an arbitrary truthy value', () => {
    expect(previewMode({})).toBe(false);
    expect(previewMode({ CAPITALDESK_UI_PREVIEW: '1' })).toBe(false);
    expect(previewMode({ CAPITALDESK_UI_PREVIEW: 'true' })).toBe(true);
  });

  it('keeps every displayed quantity exact and asset-specific', () => {
    for (const row of CAPITAL) {
      for (const value of [row.account, row.available, row.reserved, row.house, row.quarantined]) {
        expect(isCanonicalDecimal(value), `${row.asset} ${value}`).toBe(true);
      }
    }
    for (const intent of INTENTS) {
      for (const value of [intent.target, intent.owned, intent.committed]) {
        expect(isCanonicalDecimal(value), `${intent.strategy} ${value}`).toBe(true);
      }
    }
  });

  it('exercises long identifiers, conflict, quarantine, zero and long precision states', () => {
    expect(INTENTS.some((intent) => intent.id.length > 24)).toBe(true);
    expect(INTENTS.some((intent) => intent.state === 'CONFLICT')).toBe(true);
    expect(CAPITAL.some((row) => row.status === 'DRIFT QUARANTINE')).toBe(true);
    expect(CAPITAL.some((row) => row.quarantined === '0.00000000')).toBe(true);
    expect(CAPITAL.every((row) => row.account.includes('.'))).toBe(true);
  });
});
