import { describe, expect, it, vi } from 'vitest';
import type { JobJournal, JobQueue, WorkerScope } from './scheduler.js';
import { runOneWorkerJob } from './scheduler.js';

const scope: WorkerScope = {
  workspaceId: 'ws-1',
  poolId: 'pool-1',
  workerId: 'worker-1',
  leaseMs: 30_000,
};

function queueWith(kind: 'job.reconcile' | 'job.export'): JobQueue {
  return {
    claim: vi.fn().mockResolvedValue({ jobId: 'job-1', kind, payload: {}, attempt: 1 }),
  };
}

function journal(): JobJournal {
  return {
    acknowledge: vi.fn().mockResolvedValue({ ok: true }),
    fail: vi.fn().mockResolvedValue({ kind: 'retry-later' }),
  };
}

describe('runOneWorkerJob', () => {
  it('acknowledges a handled job with the same lease identity', async () => {
    const jobs = queueWith('job.reconcile');
    const state = journal();
    const handler = vi.fn().mockResolvedValue(undefined);

    await expect(
      runOneWorkerJob(jobs, state, { 'job.reconcile': handler }, scope),
    ).resolves.toEqual({ kind: 'completed', jobId: 'job-1' });
    expect(handler).toHaveBeenCalledOnce();
    expect(state.acknowledge).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      poolId: 'pool-1',
      outboxId: 'job-1',
      consumerId: 'worker-1',
    });
    expect(state.fail).not.toHaveBeenCalled();
  });

  it('releases a failed handler for bounded retry without storing its message', async () => {
    const state = journal();
    const handler = vi.fn().mockRejectedValue(new Error('sensitive upstream details'));

    await expect(
      runOneWorkerJob(queueWith('job.export'), state, { 'job.export': handler }, scope),
    ).resolves.toEqual({ kind: 'retry-later', jobId: 'job-1' });
    expect(state.fail).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'handler failed: Error', consumerId: 'worker-1' }),
    );
    expect(state.acknowledge).not.toHaveBeenCalled();
  });

  it('reports a lost lease instead of claiming completion', async () => {
    const state = journal();
    vi.mocked(state.acknowledge).mockResolvedValue({ ok: false, reason: 'NOT_HELD' });

    await expect(
      runOneWorkerJob(
        queueWith('job.reconcile'),
        state,
        { 'job.reconcile': vi.fn().mockResolvedValue(undefined) },
        scope,
      ),
    ).resolves.toEqual({ kind: 'lease-lost', jobId: 'job-1' });
  });
});
