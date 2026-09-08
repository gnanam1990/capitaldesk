import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ContractViolation } from '@capitaldesk/contracts';
import { ApprovalRepository, type ApprovalOutcome, type RevokeOutcome } from '@capitaldesk/db';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = '^sha256:[0-9a-f]{64}$';

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

function sendFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  failure: Exclude<ApprovalOutcome | RevokeOutcome, { ok: true }>,
): FastifyReply {
  const code =
    failure.reason === 'APPROVAL_DIGEST_MISMATCH'
      ? 'APPROVAL_DIGEST_MISMATCH'
      : failure.reason === 'APPROVAL_EXPIRED'
        ? 'APPROVAL_EXPIRED'
        : failure.reason === 'AUTHORITY_UNAVAILABLE'
          ? 'AUTHZ_SCOPE_DENIED'
          : failure.reason === 'IDEMPOTENCY_CONFLICT'
            ? 'IDEMPOTENCY_BODY_CONFLICT'
            : 'APPROVAL_REVOKED';
  return reply.code(failure.reason === 'UNKNOWN_PLAN' ? 404 : 409).send({
    code,
    message: failure.reason.toLowerCase().replaceAll('_', ' '),
    correlationId: request.id,
    retryable: false,
  });
}

function sendContractFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (!(error instanceof ContractViolation)) throw error;
  const status =
    error.reason === 'IDENTITY_SCOPE_MISMATCH' || error.reason === 'AUTHZ_SCOPE_DENIED' ? 404 : 400;
  return reply.code(status).send({
    code: error.reason,
    message: error.message.slice(error.reason.length + 2),
    correlationId: request.id,
    retryable: false,
  });
}

export function registerApprovalRoutes(
  app: FastifyInstance,
  options: { readonly repository: ApprovalRepository },
): void {
  const csrfProtection = app.csrfProtection.bind(app);
  const { repository } = options;

  app.post<{
    Params: { workspaceId: string; poolId: string; planId: string };
    Body: {
      planDigest: string;
      decision: 'APPROVED' | 'DECLINED';
      executionMode: 'BROKER_KEY' | 'APPROVED_HOST';
    };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/plans/:planId/approval',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['planDigest', 'decision', 'executionMode'],
          properties: {
            planDigest: { type: 'string', pattern: DIGEST_PATTERN },
            decision: { type: 'string', enum: ['APPROVED', 'DECLINED'] },
            executionMode: { type: 'string', enum: ['BROKER_KEY', 'APPROVED_HOST'] },
          },
        },
      },
      onRequest: app.requireOwnerSession,
      preHandler: csrfProtection,
    },
    async (request, reply) => {
      const actor = request.principal;
      if (actor === undefined) return reply.code(401).send();
      try {
        const outcome = await repository.decide({
          ...request.params,
          ...request.body,
          idempotencyKey: idempotencyKey(request),
          actor,
        });
        return outcome.ok
          ? reply.code(outcome.replayed ? 200 : 201).send(outcome)
          : sendFailure(request, reply, outcome);
      } catch (error) {
        return sendContractFailure(request, reply, error);
      }
    },
  );

  app.post<{
    Params: { workspaceId: string; poolId: string; planId: string };
    Body: { planDigest: string; reason: string };
  }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/plans/:planId/approval/revoke',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['planDigest', 'reason'],
          properties: {
            planDigest: { type: 'string', pattern: DIGEST_PATTERN },
            reason: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
      onRequest: app.requireCapability('plan.decline'),
      preHandler: csrfProtection,
    },
    async (request, reply) => {
      const actor = request.principal;
      if (actor === undefined) return reply.code(401).send();
      try {
        const outcome = await repository.revoke({
          ...request.params,
          ...request.body,
          idempotencyKey: idempotencyKey(request),
          actor,
        });
        return outcome.ok
          ? reply.code(outcome.replayed ? 200 : 201).send(outcome)
          : sendFailure(request, reply, outcome);
      } catch (error) {
        return sendContractFailure(request, reply, error);
      }
    },
  );

  app.get<{ Params: { workspaceId: string; poolId: string; planId: string } }>(
    '/v1/workspaces/:workspaceId/pools/:poolId/plans/:planId/approval',
    { onRequest: app.requireCapability('plan.read') },
    async (request, reply) => {
      const actor = request.principal;
      if (actor === undefined) return reply.code(401).send();
      try {
        const approval = await repository.view({ ...request.params, actor });
        return approval === null ? reply.code(404).send() : reply.send({ approval });
      } catch (error) {
        return sendContractFailure(request, reply, error);
      }
    },
  );
}
