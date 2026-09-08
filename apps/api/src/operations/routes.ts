import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { EventRepository, PublicReadRepository } from '@capitaldesk/db';
import { openApiDocument, PUBLIC_SCHEMAS } from '../openapi.js';

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new TypeError('Idempotency-Key must be 1-48 safe identifier characters');
  }
  return value;
}

function limit(value: string | undefined): number {
  return value === undefined ? 50 : Number(value);
}

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  return reply.code(error instanceof TypeError ? 400 : 409).send({
    code: error instanceof TypeError ? 'IDENTITY_MALFORMED' : 'IDEMPOTENCY_BODY_CONFLICT',
    message: error instanceof Error ? error.message : 'request failed',
    correlationId: request.id,
    retryable: false,
  });
}

export function registerOperationalRoutes(
  app: FastifyInstance,
  options: {
    readonly reads: PublicReadRepository;
    readonly events: EventRepository;
  },
): void {
  const csrfProtection = app.csrfProtection.bind(app);

  app.get('/openapi.json', () => openApiDocument());

  app.get<{ Params: { workspaceId: string; poolId: string } }>(
    '/v1/workspaces/:workspaceId/pools/:poolId',
    {
      schema: { params: PUBLIC_SCHEMAS.poolParams },
      onRequest: app.requireCapability('pool.read'),
    },
    async (request, reply) => {
      if (request.principal === undefined) return reply.code(401).send();
      const state = await options.reads.poolState({ ...request.params, actor: request.principal });
      return state === null ? reply.code(404).send() : reply.send({ pool: state });
    },
  );

  app.get<{
    Params: { workspaceId: string; poolId: string };
    Querystring: { after?: string; limit?: string };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/plans',
    {
      schema: { params: PUBLIC_SCHEMAS.poolParams, querystring: PUBLIC_SCHEMAS.planListQuery },
      onRequest: app.requireCapability('plan.read'),
    },
    async (request, reply) => {
      if (request.principal === undefined) return reply.code(401).send();
      const plans = await options.reads.plans({
        ...request.params,
        afterPlanId: request.query.after ?? '',
        limit: limit(request.query.limit),
        actor: request.principal,
      });
      return reply.send({ plans, nextCursor: plans.at(-1)?.['planId'] ?? null });
    },
  );

  app.get<{
    Params: { workspaceId: string; poolId: string; strategyId: string; planId: string };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/strategies/:strategyId/plans/:planId',
    { onRequest: app.requireCapability('plan.read') },
    async (request, reply) => {
      if (request.principal === undefined) return reply.code(401).send();
      const plan = await options.reads.strategyPlan({
        ...request.params,
        actor: request.principal,
      });
      return plan === null ? reply.code(404).send() : reply.send({ plan });
    },
  );

  app.get<{
    Params: { workspaceId: string; poolId: string };
    Querystring: { after?: string; limit?: string };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/ledger',
    {
      schema: { params: PUBLIC_SCHEMAS.poolParams, querystring: PUBLIC_SCHEMAS.revisionListQuery },
      onRequest: app.requireCapability('ledger.read'),
    },
    async (request, reply) => {
      if (request.principal === undefined) return reply.code(401).send();
      const entries = await options.reads.ledger({
        ...request.params,
        afterRevision: request.query.after ?? '0',
        limit: limit(request.query.limit),
        actor: request.principal,
      });
      return reply.send({ entries, nextCursor: entries.at(-1)?.['revision'] ?? null });
    },
  );

  app.get<{
    Params: { workspaceId: string; poolId: string };
    Querystring: { after?: string; limit?: string };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/events',
    {
      schema: { params: PUBLIC_SCHEMAS.poolParams, querystring: PUBLIC_SCHEMAS.revisionListQuery },
      onRequest: app.requireCapability('pool.read'),
    },
    async (request, reply) => {
      if (request.principal === undefined) return reply.code(401).send();
      const header = request.headers['last-event-id'];
      const afterEventId =
        request.query.after ?? (typeof header === 'string' && header.length > 0 ? header : '0');
      try {
        const events = await options.events.list({
          ...request.params,
          afterEventId,
          limit: limit(request.query.limit),
          actor: request.principal,
        });
        const body = events
          .map(
            (event) =>
              `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify({
                subjectRef: event.subjectRef,
                occurredAt: event.occurredAt.toISOString(),
                payload: event.payload,
              })}\n\n`,
          )
          .join('');
        return reply.header('content-type', 'text/event-stream; charset=utf-8').send(body);
      } catch (error) {
        return failure(request, reply, error);
      }
    },
  );

  for (const action of ['reconcile', 'exports'] as const) {
    app.post<{
      Params: { workspaceId: string; poolId: string };
      Body: { reason: string };
    }>(
      `/v1/workspaces/:workspaceId/pools/:poolId/${action}`,
      {
        schema: { params: PUBLIC_SCHEMAS.poolParams, body: PUBLIC_SCHEMAS.jobBody },
        onRequest: app.requireCapability(
          action === 'reconcile' ? 'pool.reconcile' : 'export.create',
        ),
        preHandler: csrfProtection,
      },
      async (request, reply) => {
        if (request.principal === undefined) return reply.code(401).send();
        try {
          const key = idempotencyKey(request);
          const result = await options.events.enqueueJob({
            ...request.params,
            jobId: `${action === 'reconcile' ? 'rec' : 'exp'}-${key}`,
            kind: action === 'reconcile' ? 'job.reconcile' : 'job.export',
            payload: { reason: request.body.reason },
            actor: request.principal,
          });
          return reply.code(result.replayed ? 200 : 202).send({
            jobId: `${action === 'reconcile' ? 'rec' : 'exp'}-${key}`,
            state: 'QUEUED',
            replayed: result.replayed,
          });
        } catch (error) {
          return failure(request, reply, error);
        }
      },
    );
  }
}
