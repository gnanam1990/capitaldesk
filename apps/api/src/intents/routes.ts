import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ContractViolation } from '@capitaldesk/contracts';
import {
  IntentRepository,
  type ProposeIntentOutcome,
  type TargetControlOutcome,
} from '@capitaldesk/db';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_SCHEMA = { type: 'string', pattern: ID_PATTERN.source } as const;
const SYMBOL_SCHEMA = { type: 'string', pattern: '^[A-Z0-9]{2,32}$' } as const;
const ATOMS_SCHEMA = { type: 'string', pattern: '^(0|[1-9][0-9]{0,77})$' } as const;
const POSITIVE_INTEGER_SCHEMA = { type: 'string', pattern: '^[1-9][0-9]{0,77}$' } as const;
const PRICE_SCHEMA = {
  anyOf: [{ type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' }, { type: 'null' }],
} as const;
const TARGET_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intentId',
    'symbol',
    'targetBaseQtyAtoms',
    'maxBuyPrice',
    'minSellPrice',
    'maxQuoteDebitAtoms',
    'expiresAt',
    'strategyRevision',
    'policyVersion',
  ],
  properties: {
    intentId: ID_SCHEMA,
    symbol: SYMBOL_SCHEMA,
    targetBaseQtyAtoms: ATOMS_SCHEMA,
    maxBuyPrice: PRICE_SCHEMA,
    minSellPrice: PRICE_SCHEMA,
    maxQuoteDebitAtoms: ATOMS_SCHEMA,
    expiresAt: { type: 'string', format: 'date-time' },
    strategyRevision: POSITIVE_INTEGER_SCHEMA,
    policyVersion: POSITIVE_INTEGER_SCHEMA,
  },
} as const;

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ContractViolation(
      'IDENTITY_MALFORMED',
      'Idempotency-Key must be 1-64 chars of [A-Za-z0-9._-]',
    );
  }
  return value;
}

function expectedVersion(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new ContractViolation(
      'IDENTITY_MALFORMED',
      'expectedVersion is outside the supported range',
    );
  }
  return parsed;
}

function sendFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  failure: Exclude<ProposeIntentOutcome | TargetControlOutcome, { ok: true }>,
): FastifyReply {
  const code =
    failure.reason === 'IDEMPOTENCY_CONFLICT'
      ? 'IDEMPOTENCY_BODY_CONFLICT'
      : failure.reason === 'REVISION_NOT_MONOTONIC'
        ? 'INTENT_REVISION_NOT_MONOTONIC'
        : failure.reason === 'REVISION_CONFLICT'
          ? 'INTENT_REPLAY_BODY_CONFLICT'
          : failure.reason === 'VERSION_CONFLICT'
            ? 'IDENTITY_SCOPE_MISMATCH'
            : 'IDEMPOTENCY_BODY_CONFLICT';
  return reply.code(409).send({
    code,
    message: failure.reason.toLowerCase().replaceAll('_', ' '),
    correlationId: request.id,
    retryable: false,
    ...('currentRevision' in failure ? { currentRevision: failure.currentRevision } : {}),
  });
}

function sendContractFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (!(error instanceof ContractViolation)) throw error;
  const status =
    error.reason === 'IDENTITY_SCOPE_MISMATCH' || error.reason === 'AUTHZ_SCOPE_DENIED'
      ? 404
      : error.reason.startsWith('INTENT_') || error.reason.startsWith('POLICY_')
        ? 409
        : 400;
  return reply.code(status).send({
    code: error.reason,
    message: error.message.slice(error.reason.length + 2),
    correlationId: request.id,
    retryable: false,
  });
}

export function registerIntentRoutes(
  app: FastifyInstance,
  options: { readonly repository: IntentRepository },
): void {
  const csrfProtection = app.csrfProtection.bind(app);
  const { repository } = options;

  app.post<{
    Params: { workspaceId: string; poolId: string };
    Body: { strategyId: string; displayName: string };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/strategies',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['strategyId', 'displayName'],
          properties: {
            strategyId: ID_SCHEMA,
            displayName: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
      onRequest: app.requireCapability('strategy.create'),
      preHandler: csrfProtection,
    },
    async (request, reply) => {
      const actor = request.principal;
      if (actor === undefined) return reply.code(401).send();
      try {
        const result = await repository.createStrategy({
          ...request.params,
          ...request.body,
          idempotencyKey: idempotencyKey(request),
          actor,
        });
        return reply.code(result.created ? 201 : 200).send(result);
      } catch (error) {
        return sendContractFailure(request, reply, error);
      }
    },
  );

  app.delete<{
    Params: { workspaceId: string; poolId: string; strategyId: string };
    Querystring: { expectedVersion: string };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/strategies/:strategyId',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          properties: { expectedVersion: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } },
        },
      },
      onRequest: app.requireCapability('strategy.archive'),
      preHandler: csrfProtection,
    },
    async (request, reply) => {
      const actor = request.principal;
      if (actor === undefined) return reply.code(401).send();
      try {
        const result = await repository.archiveStrategy({
          ...request.params,
          expectedVersion: expectedVersion(request.query.expectedVersion),
          idempotencyKey: idempotencyKey(request),
          actor,
        });
        return result.archived
          ? reply.send(result)
          : reply.code(409).send({
              code: 'IDENTITY_SCOPE_MISMATCH',
              message: 'strategy is absent, archived, or its version changed',
              correlationId: request.id,
              retryable: false,
            });
      } catch (error) {
        return sendContractFailure(request, reply, error);
      }
    },
  );

  app.post<{
    Params: { workspaceId: string; poolId: string; strategyId: string };
    Body: {
      intentId: string;
      symbol: string;
      targetBaseQtyAtoms: string;
      maxBuyPrice: string | null;
      minSellPrice: string | null;
      maxQuoteDebitAtoms: string;
      expiresAt: string;
      strategyRevision: string;
      policyVersion: string;
    };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/strategies/:strategyId/intents',
    { schema: { body: TARGET_BODY_SCHEMA }, onRequest: app.requireCapability('intent.propose') },
    async (request, reply) => {
      const actor = request.principal;
      if (actor === undefined) return reply.code(401).send();
      try {
        const outcome = await repository.propose({
          ...request.params,
          idempotencyKey: idempotencyKey(request),
          proposal: request.body,
          actor,
        });
        return outcome.ok
          ? reply.code(outcome.intent.replayed ? 200 : 201).send(outcome.intent)
          : sendFailure(request, reply, outcome);
      } catch (error) {
        return sendContractFailure(request, reply, error);
      }
    },
  );

  app.get<{ Params: { workspaceId: string; poolId: string; strategyId: string } }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/strategies/:strategyId/intents',
    { onRequest: app.requireCapability('intent.read') },
    async (request, reply) => {
      const actor = request.principal;
      if (actor === undefined) return reply.code(401).send();
      return reply.send({ intents: await repository.list({ ...request.params, actor }) });
    },
  );

  app.get<{ Params: { workspaceId: string; poolId: string; strategyId: string } }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/strategies/:strategyId/target-progress',
    { onRequest: app.requireCapability('intent.read') },
    async (request, reply) => {
      const actor = request.principal;
      if (actor === undefined) return reply.code(401).send();
      const progress = await repository.progress({ ...request.params, actor });
      return reply.send(
        progress === null
          ? { progress: null }
          : {
              progress: {
                asset: `${progress.target.asset.code}@${progress.target.asset.scaleVersion}`,
                targetAtoms: progress.target.atoms.toString(),
                ownedAtoms: progress.owned.atoms.toString(),
                projectedOwnedAtoms: progress.projectedOwned.atoms.toString(),
                direction: progress.direction,
                remainingAtoms: progress.remainingAtoms.toString(),
                replannable: progress.replannable,
              },
            },
      );
    },
  );

  for (const action of ['defer', 'reinstate'] as const) {
    app.post<{
      Params: { workspaceId: string; poolId: string; strategyId: string; symbol: string };
      Body: { expectedVersion: string; untilAt?: string | null };
    }>(
      `/v1/workspaces/:workspaceId/pools/:poolId/strategies/:strategyId/targets/:symbol/${action}`,
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedVersion'],
            properties: {
              expectedVersion: { type: 'string', pattern: '^(0|[1-9][0-9]{0,9})$' },
              untilAt: {
                anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
              },
            },
          },
        },
        onRequest: app.requireCapability(action === 'defer' ? 'intent.defer' : 'intent.reinstate'),
        preHandler: csrfProtection,
      },
      async (request, reply) => {
        const actor = request.principal;
        if (actor === undefined) return reply.code(401).send();
        try {
          const key = idempotencyKey(request);
          const outcome =
            action === 'defer'
              ? await repository.defer({
                  ...request.params,
                  expectedVersion: expectedVersion(request.body.expectedVersion),
                  untilAt:
                    request.body.untilAt === undefined || request.body.untilAt === null
                      ? null
                      : new Date(request.body.untilAt),
                  idempotencyKey: key,
                  actor,
                })
              : await repository.reinstate({
                  ...request.params,
                  expectedVersion: expectedVersion(request.body.expectedVersion),
                  idempotencyKey: key,
                  actor,
                });
          return outcome.ok ? reply.send(outcome) : sendFailure(request, reply, outcome);
        } catch (error) {
          return sendContractFailure(request, reply, error);
        }
      },
    );
  }
}
