import { createInterface, type Interface } from 'node:readline';
import { Writable, type Readable } from 'node:stream';

/**
 * One input session for a whole command.
 *
 * A readline interface reads ahead: it consumes whatever the input has buffered, not only the
 * line it hands back. Opening a second interface for the second prompt therefore loses the
 * rest of a piped `code\npassword\n`, which is how a scripted redeem silently reads an empty
 * password. So the session is created once and every line comes from the same iterator.
 *
 * On an interactive terminal the password must not be echoed. Readline echoes to its `output`
 * stream, so the output here is a stream the session can mute — a public interface, rather
 * than overriding readline's private `_writeToOutput`. Muting is scoped to a single read, and
 * `close()` is what restores the terminal from raw mode.
 *
 * The streams are injected so the echo behaviour can be tested without a pseudo-terminal.
 */
export interface InputSessionOptions {
  readonly input: Readable;
  /** Where prompts and permitted echo go. Never stdout: stdout carries the code alone. */
  readonly output: Writable;
  /** True when readline should behave as a terminal, which is when it echoes. */
  readonly interactive: boolean;
}

/** The operator interrupted an input read. */
export class InputInterrupted extends Error {
  constructor() {
    super('input interrupted');
    this.name = 'InputInterrupted';
  }
}

export class InputSession {
  private muted = false;
  private closed = false;
  private readonly reader: Interface;
  private readonly lines: AsyncIterator<string>;
  private readonly destination: Writable;

  /** Resolves when the operator interrupts a read. */
  private interrupted: (() => void) | null = null;

  constructor(options: InputSessionOptions) {
    this.destination = options.output;
    const gate = new Writable({
      write: (chunk: Buffer | string, _encoding, callback): void => {
        if (!this.muted) this.destination.write(chunk);
        callback();
      },
    });
    this.reader = createInterface({
      input: options.input,
      output: gate,
      terminal: options.interactive,
    });
    this.lines = this.reader[Symbol.asyncIterator]();
    // In terminal mode readline consumes Ctrl-C itself and emits SIGINT rather than letting
    // the process handler see it. Without this the iterator simply closed, `read` returned an
    // empty string, and a redemption reported WEAK_PASSWORD instead of being interrupted.
    this.reader.on('SIGINT', () => {
      this.interrupted?.();
    });
  }

  /**
   * Read one line. `secret: true` suppresses echo for the duration of that read.
   *
   * Throws {@link InputInterrupted} when the operator interrupts, so the caller can exit on
   * the interrupted path rather than proceeding with an empty answer.
   */
  async read(prompt: string, secret: boolean): Promise<string> {
    this.destination.write(prompt);
    this.muted = secret;
    try {
      const interrupt = new Promise<never>((_, reject) => {
        this.interrupted = () => reject(new InputInterrupted());
      });
      const next = await Promise.race([this.lines.next(), interrupt]);
      // End of input is a value, not a hang: the caller gets an empty string and the policy
      // check refuses it.
      return next.done === true ? '' : next.value;
    } finally {
      this.interrupted = null;
      this.muted = false;
      // The Enter keystroke was swallowed with the rest of the echo; end the line here so the
      // next prompt does not print on top of it.
      if (secret) this.destination.write('\n');
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
  }
}
