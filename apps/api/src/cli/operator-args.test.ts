import { describe, expect, it } from 'vitest';
import { parseOperatorArgs } from './operator-args.js';

describe('operator CLI arguments', () => {
  it('binds approval to an explicit target, digest, mode and idempotency key', () => {
    expect(
      parseOperatorArgs([
        'approve',
        '--workspace',
        'ws-1',
        '--pool',
        'pool-1',
        '--plan',
        'plan-1',
        '--digest',
        `sha256:${'a'.repeat(64)}`,
        '--mode',
        'BROKER_KEY',
        '--idempotency-key',
        'approve-1',
      ]),
    ).toMatchObject({ kind: 'approve', planId: 'plan-1', idempotencyKey: 'approve-1' });
  });

  it('refuses approval without the exact digest', () => {
    expect(() =>
      parseOperatorArgs([
        'approve',
        '--workspace',
        'ws',
        '--pool',
        'pool',
        '--plan',
        'p',
        '--digest',
        'latest',
        '--mode',
        'BROKER_KEY',
        '--idempotency-key',
        'key',
      ]),
    ).toThrow(/digest/);
  });

  it('never accepts private keys or secrets on the process command line', () => {
    expect(() => parseOperatorArgs(['pool', '--private-key', 'leak'])).toThrow(/never accepted/);
  });

  it('rejects options outside the selected command contract', () => {
    expect(() =>
      parseOperatorArgs(['pool', '--workspace', 'ws', '--pool', 'pool', '--reason', 'hidden']),
    ).toThrow(/unsupported option --reason/);
  });
});
