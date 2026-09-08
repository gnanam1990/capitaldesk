export interface RestoreCommandAuthorization {
  readonly reason: string;
}

export function authorizeRestoreCommand(env: NodeJS.ProcessEnv): RestoreCommandAuthorization {
  if (env['CAPITALDESK_RESTORE_ACK'] !== 'HALT_AND_RECONCILE') {
    throw new Error(
      'CAPITALDESK_RESTORE_ACK must equal HALT_AND_RECONCILE; restore posture halts pools and quarantines pending outbox work',
    );
  }
  const reason = env['CAPITALDESK_RESTORE_REASON'];
  if (reason === undefined || reason.trim().length < 8) {
    throw new Error('CAPITALDESK_RESTORE_REASON must describe the restore source');
  }
  return { reason: reason.trim() };
}
