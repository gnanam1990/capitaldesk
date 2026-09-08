export type PlanState =
  | 'PREVIEW'
  | 'SEALED_AWAITING_APPROVAL'
  | 'APPROVED'
  | 'DISPATCH_PENDING'
  | 'EXECUTING'
  | 'RECONCILING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'UNFILLED'
  | 'INVALIDATED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'MANUAL_REVIEW';

export interface CapitalDeskClientOptions {
  readonly baseUrl: string;
  readonly authorization?: string;
  readonly cookie?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class CapitalDeskHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`CapitalDesk HTTP ${String(status)}`);
    this.name = 'CapitalDeskHttpError';
  }
}

export class CapitalDeskClient {
  private readonly base: URL;
  private readonly send: typeof globalThis.fetch;

  constructor(private readonly options: CapitalDeskClientOptions) {
    this.base = new URL(options.baseUrl);
    if (this.base.protocol !== 'https:' && this.base.hostname !== '127.0.0.1') {
      throw new TypeError('CapitalDesk SDK requires HTTPS except for loopback development');
    }
    this.send = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.authorization !== undefined)
      headers['authorization'] = this.options.authorization;
    if (this.options.cookie !== undefined) headers['cookie'] = this.options.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    // Exactly one fetch. Economic writes are never retried by the SDK, including on timeout.
    const response = await this.send(new URL(path, this.base), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new CapitalDeskHttpError(response.status, result);
    return result as T;
  }

  pool(workspaceId: string, poolId: string): Promise<unknown> {
    return this.request(
      'GET',
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/pools/${encodeURIComponent(poolId)}`,
    );
  }

  plans(
    workspaceId: string,
    poolId: string,
    after = '',
  ): Promise<{
    readonly plans: readonly { readonly planId: string; readonly state: PlanState }[];
    readonly nextCursor: string | null;
  }> {
    const query = after === '' ? '' : `?after=${encodeURIComponent(after)}`;
    return this.request(
      'GET',
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/pools/${encodeURIComponent(poolId)}/plans${query}`,
    );
  }

  ledger(workspaceId: string, poolId: string, afterRevision = '0'): Promise<unknown> {
    return this.request(
      'GET',
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/pools/${encodeURIComponent(poolId)}/ledger?after=${encodeURIComponent(afterRevision)}`,
    );
  }

  strategyProgress(workspaceId: string, poolId: string, strategyId: string): Promise<unknown> {
    return this.request(
      'GET',
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/pools/${encodeURIComponent(poolId)}/strategies/${encodeURIComponent(strategyId)}/target-progress`,
    );
  }

  strategyPlan(
    workspaceId: string,
    poolId: string,
    strategyId: string,
    planId: string,
  ): Promise<unknown> {
    return this.request(
      'GET',
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/pools/${encodeURIComponent(poolId)}/strategies/${encodeURIComponent(strategyId)}/plans/${encodeURIComponent(planId)}`,
    );
  }

  strategyIntents(workspaceId: string, poolId: string, strategyId: string): Promise<unknown> {
    return this.request(
      'GET',
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/pools/${encodeURIComponent(poolId)}/strategies/${encodeURIComponent(strategyId)}/intents`,
    );
  }

  proposeTarget(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly idempotencyKey: string;
    readonly proposal: Readonly<Record<string, unknown>>;
  }): Promise<unknown> {
    return this.request(
      'POST',
      `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/pools/${encodeURIComponent(input.poolId)}/strategies/${encodeURIComponent(input.strategyId)}/intents`,
      input.proposal,
      input.idempotencyKey,
    );
  }

  approve(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly planId: string;
    readonly planDigest: string;
    readonly executionMode: 'BROKER_KEY' | 'APPROVED_HOST';
    readonly idempotencyKey: string;
  }): Promise<unknown> {
    return this.request(
      'POST',
      `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/pools/${encodeURIComponent(input.poolId)}/plans/${encodeURIComponent(input.planId)}/approval`,
      { planDigest: input.planDigest, decision: 'APPROVED', executionMode: input.executionMode },
      input.idempotencyKey,
    );
  }

  reconcile(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): Promise<unknown> {
    return this.request(
      'POST',
      `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/pools/${encodeURIComponent(input.poolId)}/reconcile`,
      { reason: input.reason },
      input.idempotencyKey,
    );
  }
}
