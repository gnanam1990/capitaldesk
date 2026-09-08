import type { AcknowledgeOutcome, FailOutcome, WorkerJob, WorkerJobKind } from '@capitaldesk/db';

export interface WorkerScope {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly workerId: string;
  readonly leaseMs: number;
}

export interface JobQueue {
  claim(this: void, scope: WorkerScope): Promise<WorkerJob | null>;
}

export interface JobJournal {
  acknowledge(
    this: void,
    input: {
      readonly workspaceId: string;
      readonly poolId: string;
      readonly outboxId: string;
      readonly consumerId: string;
    },
  ): Promise<AcknowledgeOutcome>;
  fail(
    this: void,
    input: {
      readonly workspaceId: string;
      readonly poolId: string;
      readonly outboxId: string;
      readonly consumerId: string;
      readonly reason: string;
    },
  ): Promise<FailOutcome>;
}

export type JobHandler = (job: WorkerJob) => Promise<void>;
export type JobHandlers = Readonly<Partial<Record<WorkerJobKind, JobHandler>>>;

export type WorkerRunOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'completed'; readonly jobId: string }
  | { readonly kind: 'lease-lost'; readonly jobId: string }
  | { readonly kind: 'retry-later'; readonly jobId: string }
  | { readonly kind: 'dead-lettered'; readonly jobId: string };

function failureReason(error: unknown): string {
  if (error instanceof Error) return `handler failed: ${error.name}`;
  return 'handler failed: non-error rejection';
}

/**
 * Run at most one retryable worker job. The queue type cannot return dispatch messages, and
 * completion is recorded only while this worker still owns the live lease.
 */
export async function runOneWorkerJob(
  queue: JobQueue,
  journal: JobJournal,
  handlers: JobHandlers,
  scope: WorkerScope,
): Promise<WorkerRunOutcome> {
  const job = await queue.claim(scope);
  if (job === null) return { kind: 'idle' };

  const handler = handlers[job.kind];
  try {
    if (handler === undefined) throw new TypeError(`no handler registered for ${job.kind}`);
    await handler(job);
  } catch (error) {
    const failed = await journal.fail({
      workspaceId: scope.workspaceId,
      poolId: scope.poolId,
      outboxId: job.jobId,
      consumerId: scope.workerId,
      reason: failureReason(error),
    });
    if (failed.kind === 'not-held') return { kind: 'lease-lost', jobId: job.jobId };
    return { kind: failed.kind, jobId: job.jobId };
  }

  const acknowledged = await journal.acknowledge({
    workspaceId: scope.workspaceId,
    poolId: scope.poolId,
    outboxId: job.jobId,
    consumerId: scope.workerId,
  });
  return acknowledged.ok
    ? { kind: 'completed', jobId: job.jobId }
    : { kind: 'lease-lost', jobId: job.jobId };
}
