import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ContractViolation } from '@capitaldesk/contracts';
import { PolicyRepository, type PublishPolicyOutcome } from '@capitaldesk/db';
import type { MandatePolicyWire } from '@capitaldesk/domain';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_SCHEMA = { type: 'string', pattern: ID_PATTERN.source } as const;
const ATOMS_SCHEMA = { type: 'string', pattern: '^(0|[1-9][0-9]{0,77})$' } as const;
const POSITIVE_SCHEMA = { type: 'string', pattern: '^[1-9][0-9]{0,77}$' } as const;
const STRATEGY_LIMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'strategyId',
    'maxTargetBaseAtoms',
    'maxPlanQuoteDebitAtoms',
    'maxDailyGrossBuyQuoteAtoms',
  ],
  properties: {
    strategyId: ID_SCHEMA,
    maxTargetBaseAtoms: ATOMS_SCHEMA,
    maxPlanQuoteDebitAtoms: ATOMS_SCHEMA,
    maxDailyGrossBuyQuoteAtoms: ATOMS_SCHEMA,
  },
} as const;
const POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'policyVersion',
    'selectedSymbol',
    'baseAsset',
    'quoteAsset',
    'maxPoolPlanQuoteDebitAtoms',
    'maxDailyGrossBuyQuoteAtoms',
    'poolConcentrationNumerator',
    'poolConcentrationDenominator',
    'freshnessMaxAgeMs',
    'planLifetimeMs',
    'buyInhibitUntil',
    'riskIncreaseHalted',
    'feePolicyVersion',
    'strategyLimits',
  ],
  properties: {
    policyVersion: POSITIVE_SCHEMA,
    selectedSymbol: { type: 'string', pattern: '^[A-Z0-9]{2,32}$' },
    baseAsset: { type: 'string', pattern: '^[A-Z0-9]{1,16}@[A-Za-z0-9._-]{1,32}$' },
    quoteAsset: { type: 'string', pattern: '^[A-Z0-9]{1,16}@[A-Za-z0-9._-]{1,32}$' },
    maxPoolPlanQuoteDebitAtoms: ATOMS_SCHEMA,
    maxDailyGrossBuyQuoteAtoms: ATOMS_SCHEMA,
    poolConcentrationNumerator: ATOMS_SCHEMA,
    poolConcentrationDenominator: POSITIVE_SCHEMA,
    freshnessMaxAgeMs: {
      type: 'object',
      additionalProperties: false,
      required: ['PRICE_SNAPSHOT', 'ACCOUNT_SNAPSHOT', 'SYMBOL_METADATA', 'VENUE_CLOCK'],
      properties: {
        PRICE_SNAPSHOT: POSITIVE_SCHEMA,
        ACCOUNT_SNAPSHOT: POSITIVE_SCHEMA,
        SYMBOL_METADATA: POSITIVE_SCHEMA,
        VENUE_CLOCK: POSITIVE_SCHEMA,
      },
    },
    planLifetimeMs: POSITIVE_SCHEMA,
    buyInhibitUntil: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
    riskIncreaseHalted: { type: 'boolean' },
    feePolicyVersion: ID_SCHEMA,
    strategyLimits: { type: 'array', minItems: 1, maxItems: 256, items: STRATEGY_LIMIT_SCHEMA },
  },
} as const;

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ContractViolation('IDENTITY_MALFORMED', 'Idempotency-Key is malformed');
  }
  return value;
}

function expectedVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
    throw new ContractViolation('IDENTITY_MALFORMED', 'expectedVersion is malformed');
  }
  return version;
}

function sendFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  failure: Exclude<PublishPolicyOutcome, { ok: true }>,
): FastifyReply {
  return reply.code(409).send({
    code:
      failure.reason === 'IDEMPOTENCY_CONFLICT'
        ? 'IDEMPOTENCY_BODY_CONFLICT'
        : 'POLICY_MANDATE_VERSION_STALE',
    message: failure.reason.toLowerCase().replaceAll('_', ' '),
    currentPolicyVersion: failure.currentPolicyVersion,
    correlationId: request.id,
    retryable: false,
  });
}

function sendContractFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (!(error instanceof ContractViolation)) throw error;
  const status = error.reason.startsWith('AUTHZ_')
    ? 403
    : error.reason.startsWith('POLICY_')
      ? 409
      : 400;
  return reply.code(status).send({
    code: error.reason,
    message: error.message.slice(error.reason.length + 2),
    correlationId: request.id,
    retryable: false,
  });
}

export function registerPolicyRoutes(
  app: FastifyInstance,
  options: { readonly repository: PolicyRepository },
): void {
  const csrfProtection = app.csrfProtection.bind(app);
  const { repository } = options;

  app.post<{
    Params: { workspaceId: string; poolId: string };
    Querystring: { expectedVersion: string };
    Body: MandatePolicyWire;
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/policies',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          properties: { expectedVersion: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } },
        },
        body: POLICY_SCHEMA,
      },
      onRequest: app.requireCapability('policy.publish'),
      preHandler: csrfProtection,
    },
    async (request, reply) => {
      if (request.principal === undefined) return reply.code(401).send();
      try {
        const outcome = await repository.publish({
          ...request.params,
          expectedPoolVersion: expectedVersion(request.query.expectedVersion),
          idempotencyKey: idempotencyKey(request),
          draft: request.body,
          actor: request.principal,
        });
        return outcome.ok
          ? reply.code(outcome.replayed ? 200 : 201).send(outcome)
          : sendFailure(request, reply, outcome);
      } catch (error) {
        return sendContractFailure(request, reply, error);
      }
    },
  );

  app.get<{ Params: { workspaceId: string; poolId: string } }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/policies/active',
    { onRequest: app.requireCapability('pool.read') },
    async (request, reply) => {
      if (request.principal === undefined) return reply.code(401).send();
      try {
        const policy = await repository.active({ ...request.params, actor: request.principal });
        return policy === null ? reply.code(404).send() : reply.send(policy);
      } catch (error) {
        return sendContractFailure(request, reply, error);
      }
    },
  );
}
