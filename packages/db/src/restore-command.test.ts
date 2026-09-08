import { describe, expect, it } from 'vitest';
import { authorizeRestoreCommand } from './restore-command.js';

describe('restore posture command authorization', () => {
  it('requires the exact halt-and-reconcile acknowledgement', () => {
    for (const ack of [undefined, '', 'yes', 'HALT', 'halt_and_reconcile']) {
      expect(() =>
        authorizeRestoreCommand({
          CAPITALDESK_RESTORE_ACK: ack,
          CAPITALDESK_RESTORE_REASON: 'backup rehearsal',
        }),
      ).toThrow(/HALT_AND_RECONCILE/);
    }
  });

  it('requires a durable human-readable reason', () => {
    expect(() =>
      authorizeRestoreCommand({ CAPITALDESK_RESTORE_ACK: 'HALT_AND_RECONCILE' }),
    ).toThrow(/RESTORE_REASON/);
    expect(
      authorizeRestoreCommand({
        CAPITALDESK_RESTORE_ACK: 'HALT_AND_RECONCILE',
        CAPITALDESK_RESTORE_REASON: ' backup rehearsal 2026-09-08 ',
      }),
    ).toEqual({ reason: 'backup rehearsal 2026-09-08' });
  });
});
