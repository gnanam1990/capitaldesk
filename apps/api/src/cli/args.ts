/**
 * Argument parsing for the enrollment CLI.
 *
 * Separate from the entry point so it can be exercised directly, and strict on purpose: an
 * unrecognised flag is a usage error rather than something quietly ignored. That matters more
 * than tidiness here, because the flag an operator is most likely to invent is `--password`,
 * and a parser that ignores it would accept an invocation that put the owner's password into
 * `ps` output and shell history while appearing to work.
 */

export type Command =
  | {
      readonly kind: 'issue';
      readonly workspaceId: string;
      readonly loginName: string;
      readonly rotate: boolean;
    }
  | { readonly kind: 'redeem'; readonly workspaceId: string };

export interface UsageError {
  readonly kind: 'usage';
  readonly message: string;
}

export type ParsedArguments = Command | UsageError;

export const USAGE = `usage:
  enroll issue  --workspace <id> --login <name> [--rotate]
  enroll redeem --workspace <id>

issue prints a single-use code once, on stdout. Nothing recovers it afterwards; reissue instead.
redeem reads the code, then the new owner password, from stdin — one line each.
Secrets are never accepted as arguments.`;

/** Flags whose names indicate the caller is trying to pass a secret on the command line. */
const SECRET_FLAGS = ['code', 'password', 'passphrase', 'secret', 'token', 'key'];

const FLAGS: Record<
  Command['kind'],
  { value: readonly string[]; boolean: readonly string[]; required: readonly string[] }
> = {
  issue: { value: ['workspace', 'login'], boolean: ['rotate'], required: ['workspace', 'login'] },
  redeem: { value: ['workspace'], boolean: [], required: ['workspace'] },
};

function usage(message: string): UsageError {
  return { kind: 'usage', message };
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0];
  if (command !== 'issue' && command !== 'redeem') {
    return usage(command === undefined ? 'no command given' : `unknown command: ${command}`);
  }
  const spec = FLAGS[command];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) return usage(`unexpected argument: ${token}`);
    const name = token.slice(2);

    // Named before the known-flag check, so the message says why rather than "unknown flag".
    if (SECRET_FLAGS.includes(name.toLowerCase())) {
      return usage(
        `--${name} is not accepted: secrets are read from stdin, never from arguments, ` +
          'because arguments are visible in process listings and shell history',
      );
    }
    if (values.has(name) || flags.has(name)) return usage(`--${name} given more than once`);

    if (spec.boolean.includes(name)) {
      flags.add(name);
      continue;
    }
    if (!spec.value.includes(name)) return usage(`unknown flag for ${command}: --${name}`);

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return usage(`--${name} needs a value`);
    values.set(name, value);
    index += 1;
  }

  for (const name of spec.required) {
    if (!values.has(name)) return usage(`--${name} is required`);
  }

  if (command === 'issue') {
    return {
      kind: 'issue',
      workspaceId: values.get('workspace') as string,
      loginName: values.get('login') as string,
      rotate: flags.has('rotate'),
    };
  }
  return { kind: 'redeem', workspaceId: values.get('workspace') as string };
}
