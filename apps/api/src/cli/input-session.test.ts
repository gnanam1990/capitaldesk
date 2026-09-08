import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { InputInterrupted, InputSession } from './input-session.js';

/**
 * Echo suppression, proven deterministically.
 *
 * Node has no built-in pseudo-terminal, and adding a native PTY dependency to prove one
 * behaviour is a poor trade. So the session takes its streams as arguments and the test drives
 * readline in terminal mode over ordinary streams: readline echoes to `output` exactly as it
 * would to a real terminal, which is the behaviour under test.
 *
 * What this does not prove is the behaviour of a real tty device — raw mode, terminal restore
 * on interrupt. That is recorded as a manual check in docs/handoffs/03.md rather than claimed
 * here, and a piped run proves nothing about echo either way because readline does not echo
 * when `terminal` is false.
 */
function capture(): { stream: Writable; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

describe('interactive input', () => {
  it('suppresses echo for a secret read and permits it for an ordinary one', async () => {
    // Both modes, because a session that echoed nothing at all would pass a
    // suppression-only assertion while being broken. The CLI itself reads both of its lines
    // in the secret mode — the enrollment code authenticates a redemption, so it is a bearer
    // secret and not a username; that is asserted in the following test.
    const input = new PassThrough();
    const output = capture();
    const session = new InputSession({ input, output: output.stream, interactive: true });

    const ordinary = session.read('label: ', false);
    input.write('not-a-secret\n');
    expect(await ordinary).toBe('not-a-secret');

    const secret = session.read('new owner password: ', true);
    input.write('correct-horse-battery-staple-7\n');
    expect(await secret).toBe('correct-horse-battery-staple-7');
    session.close();

    const written = output.text();
    expect(written).toContain('label: ');
    expect(written).toContain('new owner password: ');
    // Echo works when it is allowed...
    expect(written).toContain('not-a-secret');
    // ...and is absent when it is not, though the session returned the value to its caller.
    expect(written).not.toContain('correct-horse-battery-staple-7');
  });

  it('hides both lines the redeem flow reads', async () => {
    // The flow as the CLI performs it: the enrollment code authenticates a redemption, so it
    // is read hidden exactly like the password. The previous version proved echo suppression
    // on a label read the CLI never makes.
    const input = new PassThrough();
    const output = capture();
    const session = new InputSession({ input, output: output.stream, interactive: true });

    const code = session.read('enrollment code: ', true);
    input.write('enr-code-9f2b1c\n');
    expect(await code).toBe('enr-code-9f2b1c');

    const password = session.read('new owner password: ', true);
    input.write('correct-horse-battery-staple-7\n');
    expect(await password).toBe('correct-horse-battery-staple-7');
    session.close();

    const written = output.text();
    expect(written).toContain('enrollment code: ');
    expect(written).toContain('new owner password: ');
    expect(written).not.toContain('enr-code-9f2b1c');
    expect(written).not.toContain('correct-horse-battery-staple-7');
  });

  it('reads both lines from one buffered write', async () => {
    // The defect this proves absent: a second readline interface consumes the buffered
    // password along with the code, leaving the second read empty.
    const input = new PassThrough();
    const output = capture();
    const session = new InputSession({ input, output: output.stream, interactive: false });

    input.write('the-code\nthe-password-is-long\n');
    expect(await session.read('code: ', false)).toBe('the-code');
    expect(await session.read('password: ', true)).toBe('the-password-is-long');
    session.close();
    expect(output.text()).not.toContain('the-password-is-long');
  });

  it('returns an empty line at end of input rather than waiting', async () => {
    const input = new PassThrough();
    const session = new InputSession({ input, output: capture().stream, interactive: false });
    input.end('only-one-line\n');

    expect(await session.read('first: ', false)).toBe('only-one-line');
    expect(await session.read('second: ', true)).toBe('');
    session.close();
  });

  it('reports an interrupt as an interrupt, not as an empty answer', async () => {
    // In terminal mode readline consumes Ctrl-C and emits SIGINT itself, so the process
    // handler never ran: the iterator closed, the read returned '', and a redemption reported
    // WEAK_PASSWORD instead of being interrupted.
    const input = new PassThrough();
    const output = capture();
    const session = new InputSession({ input, output: output.stream, interactive: true });

    const reading = session.read('new owner password: ', true);
    // What readline raises when the terminal delivers Ctrl-C.
    (session as unknown as { reader: { emit: (event: string) => void } }).reader.emit('SIGINT');
    await expect(reading).rejects.toBeInstanceOf(InputInterrupted);
    session.close();
    // Nothing of a partially typed secret is echoed on the way out.
    expect(output.text()).not.toContain('new owner password: \n\n');
  });

  it('closes idempotently, so cleanup on both a success and an error path is safe', () => {
    const session = new InputSession({
      input: new PassThrough(),
      output: capture().stream,
      interactive: false,
    });
    session.close();
    expect(() => session.close()).not.toThrow();
  });
});
