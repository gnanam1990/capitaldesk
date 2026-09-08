const ID = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' } as const;
const CURSOR = { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' } as const;
const LIMIT = { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' } as const;

export const PUBLIC_SCHEMAS = {
  poolParams: {
    type: 'object',
    additionalProperties: false,
    required: ['workspaceId', 'poolId'],
    properties: { workspaceId: ID, poolId: ID },
  },
  planListQuery: {
    type: 'object',
    additionalProperties: false,
    properties: { after: ID, limit: LIMIT },
  },
  revisionListQuery: {
    type: 'object',
    additionalProperties: false,
    properties: { after: CURSOR, limit: LIMIT },
  },
  jobBody: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: { reason: { type: 'string', minLength: 1, maxLength: 256 } },
  },
} as const;

/** OpenAPI is assembled from the same schema objects installed on the runtime routes. */
export function openApiDocument(): Readonly<Record<string, unknown>> {
  const parameters = [
    { name: 'workspaceId', in: 'path', required: true, schema: ID },
    { name: 'poolId', in: 'path', required: true, schema: ID },
  ];
  const denied = {
    description: 'Denied without disclosing object existence',
    content: {
      'application/json': {
        example: {
          code: 'AUTHZ_SCOPE_DENIED',
          message: 'not found',
          correlationId: 'example-correlation-id',
          retryable: false,
        },
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'CapitalDesk API', version: '0.1.0' },
    paths: {
      '/health/live': {
        get: { operationId: 'getLiveness', responses: { '200': { description: 'Live' } } },
      },
      '/health/ready': {
        get: {
          operationId: 'getReadiness',
          responses: {
            '200': { description: 'Operationally ready' },
            '503': { description: 'Degraded' },
          },
        },
      },
      '/v1/workspaces/{workspaceId}/pools/{poolId}': {
        get: {
          operationId: 'getPoolState',
          parameters,
          responses: { '200': { description: 'Pool state' }, '404': denied },
        },
      },
      '/v1/workspaces/{workspaceId}/pools/{poolId}/plans': {
        get: {
          operationId: 'listPlans',
          parameters,
          responses: {
            '200': { description: 'Plans, including UNKNOWN/PARTIAL states when present' },
            '404': denied,
          },
        },
      },
      '/v1/workspaces/{workspaceId}/pools/{poolId}/strategies/{strategyId}/plans/{planId}': {
        get: {
          operationId: 'getStrategyPlan',
          parameters: [
            ...parameters,
            { name: 'strategyId', in: 'path', required: true, schema: ID },
            { name: 'planId', in: 'path', required: true, schema: ID },
          ],
          responses: {
            '200': { description: 'Plan participating in the authenticated strategy' },
            '404': denied,
          },
        },
      },
      '/v1/workspaces/{workspaceId}/pools/{poolId}/ledger': {
        get: {
          operationId: 'listLedger',
          parameters,
          responses: { '200': { description: 'Exact atom-string ledger entries' }, '404': denied },
        },
      },
      '/v1/workspaces/{workspaceId}/pools/{poolId}/events': {
        get: {
          operationId: 'resumeEvents',
          parameters,
          responses: { '200': { description: 'Durable SSE catch-up' }, '404': denied },
        },
      },
      '/v1/workspaces/{workspaceId}/pools/{poolId}/reconcile': {
        post: {
          operationId: 'enqueueReconciliation',
          parameters,
          responses: { '202': { description: 'Read-only reconciliation queued' }, '404': denied },
        },
      },
      '/v1/workspaces/{workspaceId}/pools/{poolId}/exports': {
        post: {
          operationId: 'enqueueEvidenceExport',
          parameters,
          responses: { '202': { description: 'Evidence export queued' }, '404': denied },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: 'object',
          required: ['code', 'message', 'correlationId', 'retryable'],
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            correlationId: { type: 'string' },
            retryable: { type: 'boolean' },
          },
        },
      },
    },
    'x-capitaldesk-examples': {
      label: 'DOCUMENTATION_EXAMPLES_ONLY',
      outcomes: ['UNKNOWN', 'CONFLICT', 'PARTIAL', 'DEGRADED', 'DENIED'],
    },
  };
}
