import { DEPLOYMENT_ENVIRONMENTS } from '@capitaldesk/config';

/**
 * Reading the API's readiness report, and deciding what the console may present as fact.
 *
 * Extracted from the page so it can be tested directly. The defects here were not visual:
 * the console displayed its own configuration as though it described the ready API, so two
 * differently configured processes looked like one agreeing system — which is precisely the
 * drift an operator needs to see.
 */

export interface ReadinessReport {
  readonly status: 'ready' | 'not_ready';
  readonly buildId: string;
  readonly contractsVersion: string;
  readonly deploymentEnvironment: string;
  readonly accountAlias: string;
  readonly baselineEpoch: number;
  readonly dependencies: ReadonlyArray<{
    readonly name: string;
    readonly state: DependencyState;
    readonly detail: string;
  }>;
  readonly execution: { readonly available: false; readonly reason: string };
}

export type DependencyState = 'up' | 'down' | 'not_configured';
const DEPENDENCY_STATES: readonly string[] = ['up', 'down', 'not_configured'];

export type Readiness =
  | { readonly kind: 'reachable'; readonly report: ReadinessReport }
  | { readonly kind: 'unreachable'; readonly detail: string };

/** A configured base URL ending in "/" produced "//health/ready", so a healthy API read as unreachable. */
export function healthUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/health/ready`;
}

/**
 * Validate the payload against the actual contract, not merely its shape.
 *
 * A type assertion asserts nothing: malformed JSON — a truncated response, a proxy error
 * page, a future API version — threw while rendering and took the page down. The checks are
 * tight on purpose: a dependency state outside the known set, or an `execution.available`
 * that is not exactly `false`, would mean the API is speaking a contract this console does
 * not understand, and guessing at it is how a console starts showing an execution capability
 * that does not exist.
 */
export function parseReadiness(value: unknown): ReadinessReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const report = value as Record<string, unknown>;

  const strings = ['buildId', 'contractsVersion', 'deploymentEnvironment', 'accountAlias'];
  if (!strings.every((key) => typeof report[key] === 'string' && report[key] !== '')) return null;

  // The environment is an enum, not free text. An unrecognised value would be rendered in the
  // persistent environment banner, which is the one place an operator must be able to trust.
  if (
    !(DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(
      report['deploymentEnvironment'] as string,
    )
  ) {
    return null;
  }

  if (report['status'] !== 'ready' && report['status'] !== 'not_ready') return null;

  const epoch = report['baselineEpoch'];
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) return null;

  const dependencies = report['dependencies'];
  if (!Array.isArray(dependencies)) return null;
  const dependenciesValid = dependencies.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const row = entry as Record<string, unknown>;
    return (
      typeof row['name'] === 'string' &&
      typeof row['detail'] === 'string' &&
      typeof row['state'] === 'string' &&
      DEPENDENCY_STATES.includes(row['state'])
    );
  });
  if (!dependenciesValid) return null;

  const execution = report['execution'];
  if (typeof execution !== 'object' || execution === null) return null;
  const executionRow = execution as Record<string, unknown>;
  // Exactly false at this milestone. An API claiming execution is available is speaking a
  // contract this console cannot represent truthfully.
  if (executionRow['available'] !== false) return null;
  if (typeof executionRow['reason'] !== 'string' || executionRow['reason'] === '') return null;

  // The summary must agree with the detail. A report claiming `ready` while a dependency is
  // down is internally contradictory, and a console that renders it is presenting a
  // conclusion its own evidence refutes. Matches the API's own rule: ready only when every
  // dependency is up, so `not_configured` is not ready either.
  const allUp = (dependencies as ReadonlyArray<{ state: string }>).every(
    (entry) => entry.state === 'up',
  );
  if ((report['status'] === 'ready') !== allUp) return null;

  return value as ReadinessReport;
}

export interface WebPublicFacts {
  readonly accountAlias: string;
  readonly deploymentEnvironment: string;
  readonly baselineEpoch: number;
  readonly buildId: string;
}

export interface DeploymentFacts {
  readonly accountAlias: string;
  readonly deploymentEnvironment: string;
  readonly baselineEpoch: string;
  readonly buildId: string;
  /** Where these values came from. The console must say which. */
  readonly source: 'api' | 'console-configuration';
  /**
   * Fields where the console's configuration disagrees with the API's report. Surfaced
   * rather than hidden: a mismatch means the console is pointed at an API it was not
   * configured for, which is exactly what an operator must not discover later.
   */
  readonly mismatches: readonly string[];
}

/**
 * Operational facts come from the API when it answered, and only from configuration when it
 * did not — labelled as configuration in that case, never as observed truth.
 */
export function resolveDeploymentFacts(
  config: WebPublicFacts,
  readiness: Readiness,
): DeploymentFacts {
  if (readiness.kind !== 'reachable') {
    return {
      accountAlias: config.accountAlias,
      deploymentEnvironment: config.deploymentEnvironment,
      baselineEpoch: String(config.baselineEpoch),
      buildId: config.buildId,
      source: 'console-configuration',
      mismatches: [],
    };
  }

  const { report } = readiness;
  const mismatches: string[] = [];
  if (report.accountAlias !== config.accountAlias) mismatches.push('account alias');
  if (report.deploymentEnvironment !== config.deploymentEnvironment) mismatches.push('environment');
  if (report.baselineEpoch !== config.baselineEpoch) mismatches.push('baseline epoch');
  if (report.buildId !== config.buildId) mismatches.push('build');

  return {
    accountAlias: report.accountAlias,
    deploymentEnvironment: report.deploymentEnvironment,
    baselineEpoch: String(report.baselineEpoch),
    buildId: report.buildId,
    source: 'api',
    mismatches,
  };
}
