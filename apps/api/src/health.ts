import { CONTRACTS_VERSION } from '@capitaldesk/contracts';

/**
 * Truthful health reporting.
 *
 * Three facts are reported separately and must never be collapsed into one boolean
 * (PRD non-functional operability, UI-UX section 3):
 *
 *  - liveness:  this process is running.
 *  - readiness: dependencies this process needs are reachable.
 *  - execution: whether a governed order could actually be dispatched.
 *
 * "Connected" is not "safe to execute". At this milestone execution is unavailable for a
 * structural reason — the executor, planner and ledger are not implemented yet — and the
 * endpoint says exactly that instead of reporting a capability the code does not have.
 */

export type DependencyState = 'up' | 'down' | 'not_configured';

export interface DependencyReport {
  readonly name: string;
  readonly state: DependencyState;
  readonly detail: string;
}

export interface LivenessReport {
  readonly status: 'live';
  readonly buildId: string;
  readonly contractsVersion: string;
  readonly uptimeSeconds: number;
}

export interface ReadinessReport {
  readonly status: 'ready' | 'not_ready';
  readonly buildId: string;
  readonly contractsVersion: string;
  readonly deploymentEnvironment: string;
  readonly accountAlias: string;
  readonly baselineEpoch: number;
  readonly dependencies: readonly DependencyReport[];
  readonly execution: {
    readonly available: false;
    readonly reason: string;
  };
}

export function liveness(buildId: string, uptimeSeconds: number): LivenessReport {
  return {
    status: 'live',
    buildId,
    contractsVersion: CONTRACTS_VERSION,
    uptimeSeconds: Math.floor(uptimeSeconds),
  };
}

export function readiness(input: {
  readonly buildId: string;
  readonly deploymentEnvironment: string;
  readonly accountAlias: string;
  readonly baselineEpoch: number;
  readonly dependencies: readonly DependencyReport[];
}): ReadinessReport {
  const ready = input.dependencies.every((dependency) => dependency.state === 'up');
  return {
    status: ready ? 'ready' : 'not_ready',
    buildId: input.buildId,
    contractsVersion: CONTRACTS_VERSION,
    deploymentEnvironment: input.deploymentEnvironment,
    accountAlias: input.accountAlias,
    baselineEpoch: input.baselineEpoch,
    dependencies: input.dependencies,
    execution: {
      available: false,
      reason:
        'No governed execution path is implemented at this milestone. The ledger, planner, ' +
        'approval and executor modules (specs/capitaldesk prompts 04-13) are not built, and ' +
        'no venue write capability has passed its integration gate.',
    },
  };
}
