export type OperatorCommand =
  | { readonly kind: 'doctor' }
  | {
      readonly kind: 'pool' | 'plans' | 'ledger';
      readonly workspaceId: string;
      readonly poolId: string;
    }
  | {
      readonly kind: 'approve';
      readonly workspaceId: string;
      readonly poolId: string;
      readonly planId: string;
      readonly digest: string;
      readonly executionMode: 'BROKER_KEY' | 'APPROVED_HOST';
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: 'reconcile';
      readonly workspaceId: string;
      readonly poolId: string;
      readonly reason: string;
      readonly idempotencyKey: string;
    };

function values(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new TypeError('options must be --name value pairs');
    }
    if (/secret|password|private-key|signing-key/i.test(key)) {
      throw new TypeError('secrets and private keys are never accepted as CLI arguments');
    }
    if (result.has(key)) throw new TypeError(`duplicate option ${key}`);
    result.set(key, value);
  }
  return result;
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (value === undefined || value.length === 0) throw new TypeError(`${key} is required`);
  return value;
}

function allowOnly(options: Map<string, string>, allowed: readonly string[]): void {
  for (const key of options.keys()) {
    if (!allowed.includes(key)) throw new TypeError(`unsupported option ${key}`);
  }
}

export function parseOperatorArgs(argv: readonly string[]): OperatorCommand {
  const [command, ...rest] = argv;
  if (command === 'doctor' && rest.length === 0) return { kind: 'doctor' };
  if (command === undefined) throw new TypeError('a command is required');
  const options = values(rest);
  const workspaceId = required(options, '--workspace');
  const poolId = required(options, '--pool');
  if (command === 'pool' || command === 'plans' || command === 'ledger') {
    allowOnly(options, ['--workspace', '--pool']);
    return { kind: command, workspaceId, poolId };
  }
  if (command === 'approve') {
    allowOnly(options, [
      '--workspace',
      '--pool',
      '--plan',
      '--digest',
      '--mode',
      '--idempotency-key',
    ]);
    const digest = required(options, '--digest');
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new TypeError('--digest is malformed');
    const executionMode = required(options, '--mode');
    if (executionMode !== 'BROKER_KEY' && executionMode !== 'APPROVED_HOST') {
      throw new TypeError('--mode must be BROKER_KEY or APPROVED_HOST');
    }
    return {
      kind: 'approve',
      workspaceId,
      poolId,
      planId: required(options, '--plan'),
      digest,
      executionMode,
      idempotencyKey: required(options, '--idempotency-key'),
    };
  }
  if (command === 'reconcile') {
    allowOnly(options, ['--workspace', '--pool', '--reason', '--idempotency-key']);
    return {
      kind: 'reconcile',
      workspaceId,
      poolId,
      reason: required(options, '--reason'),
      idempotencyKey: required(options, '--idempotency-key'),
    };
  }
  throw new TypeError(`unsupported command ${command}`);
}
