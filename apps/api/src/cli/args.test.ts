import { describe, expect, it } from 'vitest';
import { parseArguments } from './args.js';

describe('enrollment CLI arguments', () => {
  it('parses the two supported invocations', () => {
    expect(parseArguments(['issue', '--workspace', 'ws-a', '--login', 'desk.owner'])).toEqual({
      kind: 'issue',
      workspaceId: 'ws-a',
      loginName: 'desk.owner',
      rotate: false,
    });
    expect(
      parseArguments(['issue', '--workspace', 'ws-a', '--login', 'desk.owner', '--rotate']),
    ).toEqual({ kind: 'issue', workspaceId: 'ws-a', loginName: 'desk.owner', rotate: true });
    expect(parseArguments(['redeem', '--workspace', 'ws-a'])).toEqual({
      kind: 'redeem',
      workspaceId: 'ws-a',
    });
  });

  it('refuses any flag that would put a secret on the command line', () => {
    // The failure this prevents is not a typo. An operator reaching for `--password` is about
    // to write it into their shell history and every process listing on the host.
    for (const name of ['code', 'password', 'passphrase', 'secret', 'token', 'key']) {
      const parsed = parseArguments(['redeem', '--workspace', 'ws-a', `--${name}`, 'value']);
      expect(parsed.kind, `--${name}`).toBe('usage');
      expect((parsed as { message: string }).message).toContain('read from stdin');
    }
  });

  it('refuses unknown, duplicated and value-less flags', () => {
    expect(parseArguments(['redeem', '--workspace', 'ws-a', '--force']).kind).toBe('usage');
    expect(parseArguments(['redeem', '--workspace', 'ws-a', '--workspace', 'ws-b']).kind).toBe(
      'usage',
    );
    expect(parseArguments(['redeem', '--workspace']).kind).toBe('usage');
    // A flag consuming the next flag as its value is how `--workspace --login x` silently
    // enrolls into a workspace called "--login".
    expect(parseArguments(['issue', '--workspace', '--login', 'desk.owner']).kind).toBe('usage');
    expect(parseArguments(['redeem', 'ws-a']).kind).toBe('usage');
  });

  it('refuses a flag that belongs to the other command', () => {
    expect(parseArguments(['redeem', '--workspace', 'ws-a', '--login', 'desk.owner']).kind).toBe(
      'usage',
    );
    expect(parseArguments(['redeem', '--workspace', 'ws-a', '--rotate']).kind).toBe('usage');
  });

  it('refuses a missing or unknown command', () => {
    expect(parseArguments([]).kind).toBe('usage');
    expect(parseArguments(['enroll']).kind).toBe('usage');
    expect(parseArguments(['--workspace', 'ws-a']).kind).toBe('usage');
  });

  it('requires the flags each command depends on', () => {
    expect(parseArguments(['issue', '--workspace', 'ws-a']).kind).toBe('usage');
    expect(parseArguments(['issue', '--login', 'desk.owner']).kind).toBe('usage');
    expect(parseArguments(['redeem']).kind).toBe('usage');
  });
});
