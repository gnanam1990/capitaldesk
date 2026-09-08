import { z } from 'zod';
import {
  APPROVED_VENUE_ORIGINS,
  DEPLOYMENT_ENVIRONMENTS,
  LIVE_VENUE_ORIGINS,
  type DeploymentEnvironment,
  type Environment,
  type ProcessRole,
} from '@capitaldesk/contracts';

/**
 * Environment contracts.
 *
 * Every rule here fails closed. A missing variable, an unknown variable value or a
 * combination that could route a testnet deployment at a live host refuses to start rather
 * than choosing a default. There is no fallback host, no implicit environment and no
 * "production writes enabled unless told otherwise".
 */

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(role: ProcessRole, issues: readonly string[]) {
    super(`invalid ${role} configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

/**
 * Deployment environments and the venue host allowlist.
 *
 * Both now come from `@capitaldesk/contracts`, because the read transport enforces the same
 * table at construction and two copies would eventually differ — a difference that would be
 * discovered as a signed request sent to whoever owned the other host.
 */
export { DEPLOYMENT_ENVIRONMENTS, type DeploymentEnvironment };

const VENUE_HOSTS = APPROVED_VENUE_ORIGINS;
const LIVE_HOSTS = LIVE_VENUE_ORIGINS;

export function economicEnvironmentOf(deployment: DeploymentEnvironment): Environment {
  switch (deployment) {
    case 'local':
      return 'local';
    case 'testnet':
      return 'testnet';
    case 'production-read-only':
      return 'production';
  }
}

const baseSchema = z.object({
  CAPITALDESK_ENV: z.enum(DEPLOYMENT_ENVIRONMENTS),
  CAPITALDESK_VENUE: z.literal('binance-spot'),
  CAPITALDESK_VENUE_BASE_URL: z.string().url(),
  /** Non-secret operator label for the configured account. Never an identity. */
  CAPITALDESK_ACCOUNT_ALIAS: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,39}$/, 'account alias must be 3-40 chars of [a-z0-9-]'),
  CAPITALDESK_BASELINE_EPOCH: z.coerce.number().int().min(1),
  CAPITALDESK_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  CAPITALDESK_BUILD_ID: z.string().min(1),
});

export interface BaseConfig {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly economicEnvironment: Environment;
  readonly venue: 'binance-spot';
  readonly venueBaseUrl: string;
  readonly accountAlias: string;
  readonly baselineEpoch: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly buildId: string;
}

/**
 * Variables that carry a raw venue secret **value**.
 *
 * Refused in every role, including the ones entitled to the corresponding credential. The
 * contract is that configuration carries a *reference* — a path or secret-manager URI — and
 * never the secret itself (ADR-0007), so a raw value is a contract violation wherever it
 * appears. Grouping these with the reference names previously made them legal in their
 * owning role, which is exactly where a raw secret is most likely to be pasted.
 */
export const RAW_SECRET_VARIABLES = [
  'BINANCE_API_SECRET',
  'BINANCE_SECRET_KEY',
  'BINANCE_READ_API_SECRET',
] as const;

/**
 * The reference to a venue trade credential. Legal only in the executor role; its presence
 * anywhere else is a boundary failure, not a warning (ADR-0007, TEST-PLAN T-036).
 */
export const TRADE_SECRET_VARIABLES = ['CAPITALDESK_TRADE_CREDENTIAL_REF'] as const;

/** The reference to a venue read credential. Legal only in the worker role. */
export const READ_SECRET_VARIABLES = ['CAPITALDESK_READ_CREDENTIAL_REF'] as const;

function collect<T>(result: z.ZodSafeParseResult<T>): readonly string[] {
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

function parseBase(
  env: NodeJS.ProcessEnv,
  role: ProcessRole,
  extraIssues: string[],
): BaseConfig | null {
  const parsed = baseSchema.safeParse(env);
  const issues = [...collect(parsed), ...extraIssues];

  if (parsed.success) {
    const deployment = parsed.data.CAPITALDESK_ENV;
    const url = parsed.data.CAPITALDESK_VENUE_BASE_URL;
    const allowed = VENUE_HOSTS[deployment];
    if (!allowed.includes(url)) {
      issues.push(
        `CAPITALDESK_VENUE_BASE_URL: ${url} is not allowlisted for CAPITALDESK_ENV=${deployment} ` +
          `(allowed: ${allowed.join(', ')})`,
      );
    }
    if (deployment !== 'production-read-only' && LIVE_HOSTS.has(url)) {
      issues.push(
        `CAPITALDESK_VENUE_BASE_URL: refusing to route a ${deployment} deployment at a live host`,
      );
    }
  }

  if (issues.length > 0) {
    throw new ConfigurationError(role, issues);
  }
  const data = parsed.success ? parsed.data : null;
  if (data === null) return null;

  return {
    deploymentEnvironment: data.CAPITALDESK_ENV,
    economicEnvironment: economicEnvironmentOf(data.CAPITALDESK_ENV),
    venue: data.CAPITALDESK_VENUE,
    venueBaseUrl: data.CAPITALDESK_VENUE_BASE_URL,
    accountAlias: data.CAPITALDESK_ACCOUNT_ALIAS,
    baselineEpoch: data.CAPITALDESK_BASELINE_EPOCH,
    logLevel: data.CAPITALDESK_LOG_LEVEL,
    buildId: data.CAPITALDESK_BUILD_ID,
  };
}

function forbidVariables(
  env: NodeJS.ProcessEnv,
  variables: readonly string[],
  role: ProcessRole,
): string[] {
  return variables
    .filter((name) => typeof env[name] === 'string' && env[name] !== '')
    .map(
      (name) =>
        `${name}: this credential class must not be mounted into the ${role} role ` +
        `(see ADR-0007 credential classes)`,
    );
}

/**
 * Raw secret values are refused in every role, with no owning exception.
 *
 * Applied to every loader, so there is no role in which pasting a key into the environment
 * is accepted. The corresponding `CAPITALDESK_*_CREDENTIAL_REF` remains the only way to
 * point a process at a credential.
 */
function forbidRawSecrets(env: NodeJS.ProcessEnv, role: ProcessRole): string[] {
  return RAW_SECRET_VARIABLES.filter(
    (name) => typeof env[name] === 'string' && env[name] !== '',
  ).map(
    (name) =>
      `${name}: configuration carries a credential reference, never a secret value. ` +
      `Set the matching CAPITALDESK_*_CREDENTIAL_REF in the ${role === 'executor' ? 'executor' : 'owning'} role instead.`,
  );
}

const databaseSchema = z.object({ DATABASE_URL: z.string().url() });

export interface ApiConfig extends BaseConfig {
  readonly role: 'api';
  readonly databaseUrl: string;
  readonly httpPort: number;
  readonly ownerSessionSecretRef: string;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const extra = [
    ...forbidRawSecrets(env, 'api'),
    ...forbidVariables(env, TRADE_SECRET_VARIABLES, 'api'),
    ...forbidVariables(env, READ_SECRET_VARIABLES, 'api'),
  ];
  const schema = databaseSchema.extend({
    CAPITALDESK_API_PORT: z.coerce.number().int().min(1).max(65535),
    CAPITALDESK_OWNER_SESSION_SECRET_REF: z.string().min(1),
  });
  const parsed = schema.safeParse(env);
  extra.push(...collect(parsed));
  const base = parseBase(env, 'api', extra);
  if (base === null || !parsed.success) {
    throw new ConfigurationError('api', extra);
  }
  return {
    ...base,
    role: 'api',
    databaseUrl: parsed.data.DATABASE_URL,
    httpPort: parsed.data.CAPITALDESK_API_PORT,
    ownerSessionSecretRef: parsed.data.CAPITALDESK_OWNER_SESSION_SECRET_REF,
  };
}

export interface WorkerConfig extends BaseConfig {
  readonly role: 'worker';
  readonly databaseUrl: string;
  /** A reference (path or secret-manager URI) to the VENUE_READ credential, never its value. */
  readonly readCredentialRef: string | null;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const extra = [
    ...forbidRawSecrets(env, 'worker'),
    ...forbidVariables(env, TRADE_SECRET_VARIABLES, 'worker'),
  ];
  const schema = databaseSchema.extend({
    CAPITALDESK_READ_CREDENTIAL_REF: z.string().min(1).optional(),
  });
  const parsed = schema.safeParse(env);
  extra.push(...collect(parsed));
  const base = parseBase(env, 'worker', extra);
  if (base === null || !parsed.success) {
    throw new ConfigurationError('worker', extra);
  }
  return {
    ...base,
    role: 'worker',
    databaseUrl: parsed.data.DATABASE_URL,
    readCredentialRef: parsed.data.CAPITALDESK_READ_CREDENTIAL_REF ?? null,
  };
}

/**
 * Write capability is a three-valued fact, and it starts disabled.
 *
 * `enabled` is only reachable on `testnet` with an explicitly configured trade credential
 * reference. `production-read-only` can never reach it, so no configuration mistake turns a
 * read deployment into a trading one.
 */
export type WriteCapability = 'disabled' | 'enabled';

export interface ExecutorConfig extends BaseConfig {
  readonly role: 'executor';
  readonly databaseUrl: string;
  readonly writeCapability: WriteCapability;
  readonly tradeCredentialRef: string | null;
  /** Venue recvWindow bounding the signed request, in milliseconds (ADR-0003). */
  readonly signedRequestValidityMs: number;
  /** Maximum tolerated clock skew against the venue's server time (ADR-0003). */
  readonly clockSkewBudgetMs: number;
  /** Authorization durability class required before a plan may be marked (ADR-0005). */
  readonly authorizationDurability: 'SYNCHRONOUS_REPLICA' | 'AT_RISK_SINGLE_NODE';
}

export function loadExecutorConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  const extra = [
    ...forbidRawSecrets(env, 'executor'),
    ...forbidVariables(env, READ_SECRET_VARIABLES, 'executor'),
  ];
  const schema = databaseSchema.extend({
    CAPITALDESK_WRITE_CAPABILITY: z.enum(['disabled', 'enabled']),
    CAPITALDESK_TRADE_CREDENTIAL_REF: z.string().min(1).optional(),
    // Binance rejects recvWindow above 60000.
    CAPITALDESK_SIGNED_REQUEST_VALIDITY_MS: z.coerce.number().int().min(1000).max(60_000),
    CAPITALDESK_CLOCK_SKEW_BUDGET_MS: z.coerce.number().int().min(0).max(30_000),
    CAPITALDESK_AUTHORIZATION_DURABILITY: z.enum(['SYNCHRONOUS_REPLICA', 'AT_RISK_SINGLE_NODE']),
  });
  const parsed = schema.safeParse(env);
  extra.push(...collect(parsed));

  if (parsed.success) {
    const capability = parsed.data.CAPITALDESK_WRITE_CAPABILITY;
    const deployment = env['CAPITALDESK_ENV'];
    // Stated as an allowlist rather than as one forbidden case. The previous form refused
    // production-read-only and therefore happened to permit only local and testnet, but an
    // environment added later would have been permitted by default — the wrong direction to
    // fail for a setting that grants trading authority.
    const WRITE_CAPABLE_ENVIRONMENTS: readonly string[] = ['local', 'testnet'];
    if (capability === 'enabled' && !WRITE_CAPABLE_ENVIRONMENTS.includes(deployment ?? '')) {
      extra.push(
        `CAPITALDESK_WRITE_CAPABILITY: write capability may only be enabled in ` +
          `${WRITE_CAPABLE_ENVIRONMENTS.join(' or ')}; ${String(deployment)} can never hold it. ` +
          'local is permitted only because its venue host allowlist confines it to a local ' +
          'simulator, which the fault lab needs in order to exercise the write path at all.',
      );
    }
    if (capability === 'enabled' && parsed.data.CAPITALDESK_TRADE_CREDENTIAL_REF === undefined) {
      extra.push(
        'CAPITALDESK_TRADE_CREDENTIAL_REF: write capability requires an explicit trade ' +
          'credential reference',
      );
    }
    if (
      parsed.data.CAPITALDESK_CLOCK_SKEW_BUDGET_MS >=
      parsed.data.CAPITALDESK_SIGNED_REQUEST_VALIDITY_MS
    ) {
      extra.push(
        'CAPITALDESK_CLOCK_SKEW_BUDGET_MS: the skew budget must be smaller than the signed ' +
          'request validity window, otherwise the venue cannot enforce the submission deadline',
      );
    }
  }

  const base = parseBase(env, 'executor', extra);
  if (base === null || !parsed.success) {
    throw new ConfigurationError('executor', extra);
  }
  return {
    ...base,
    role: 'executor',
    databaseUrl: parsed.data.DATABASE_URL,
    writeCapability: parsed.data.CAPITALDESK_WRITE_CAPABILITY,
    tradeCredentialRef: parsed.data.CAPITALDESK_TRADE_CREDENTIAL_REF ?? null,
    signedRequestValidityMs: parsed.data.CAPITALDESK_SIGNED_REQUEST_VALIDITY_MS,
    clockSkewBudgetMs: parsed.data.CAPITALDESK_CLOCK_SKEW_BUDGET_MS,
    authorizationDurability: parsed.data.CAPITALDESK_AUTHORIZATION_DURABILITY,
  };
}

/** Everything the browser is allowed to know. It contains no secret and no reference to one. */
export interface WebPublicConfig {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly accountAlias: string;
  readonly baselineEpoch: number;
  readonly buildId: string;
  readonly apiBaseUrl: string;
}

export function loadWebPublicConfig(env: NodeJS.ProcessEnv = process.env): WebPublicConfig {
  const schema = z.object({
    NEXT_PUBLIC_CAPITALDESK_ENV: z.enum(DEPLOYMENT_ENVIRONMENTS),
    NEXT_PUBLIC_CAPITALDESK_ACCOUNT_ALIAS: z.string().min(1),
    NEXT_PUBLIC_CAPITALDESK_BASELINE_EPOCH: z.coerce.number().int().min(1),
    NEXT_PUBLIC_CAPITALDESK_BUILD_ID: z.string().min(1),
    NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: z.string().url(),
  });
  const issues = [
    ...forbidRawSecrets(env, 'web'),
    ...forbidVariables(env, TRADE_SECRET_VARIABLES, 'web'),
    ...forbidVariables(env, READ_SECRET_VARIABLES, 'web'),
  ];
  const parsed = schema.safeParse(env);
  issues.push(...collect(parsed));
  if (!parsed.success || issues.length > 0) {
    throw new ConfigurationError('web', issues);
  }
  return {
    deploymentEnvironment: parsed.data.NEXT_PUBLIC_CAPITALDESK_ENV,
    accountAlias: parsed.data.NEXT_PUBLIC_CAPITALDESK_ACCOUNT_ALIAS,
    baselineEpoch: parsed.data.NEXT_PUBLIC_CAPITALDESK_BASELINE_EPOCH,
    buildId: parsed.data.NEXT_PUBLIC_CAPITALDESK_BUILD_ID,
    apiBaseUrl: parsed.data.NEXT_PUBLIC_CAPITALDESK_API_BASE_URL,
  };
}
