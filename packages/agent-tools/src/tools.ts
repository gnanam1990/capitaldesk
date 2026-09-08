import type { CapitalDeskClient } from '@capitaldesk/sdk';

export const CAPITALDESK_AGENT_TOOLS = [
  'get_pool_state',
  'get_strategy_allocation',
  'get_market_snapshot',
  'get_intent_status',
  'get_plan_status',
  'propose_target_position',
] as const;
export type CapitalDeskAgentTool = (typeof CAPITALDESK_AGENT_TOOLS)[number];

export const AGENT_TOOL_SCHEMAS = {
  get_pool_state: { type: 'object', additionalProperties: false, properties: {} },
  get_strategy_allocation: { type: 'object', additionalProperties: false, properties: {} },
  get_market_snapshot: {
    type: 'object',
    additionalProperties: false,
    required: ['symbol'],
    properties: { symbol: { type: 'string', pattern: '^[A-Z0-9]{2,32}$' } },
  },
  get_intent_status: {
    type: 'object',
    additionalProperties: false,
    required: ['intentId'],
    properties: { intentId: { type: 'string' } },
  },
  get_plan_status: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: { planId: { type: 'string' } },
  },
  propose_target_position: {
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
      'idempotencyKey',
    ],
    properties: {
      intentId: { type: 'string' },
      symbol: { type: 'string' },
      targetBaseQtyAtoms: { type: 'string' },
      maxBuyPrice: { type: ['string', 'null'] },
      minSellPrice: { type: ['string', 'null'] },
      maxQuoteDebitAtoms: { type: 'string' },
      expiresAt: { type: 'string' },
      strategyRevision: { type: 'string' },
      policyVersion: { type: 'string' },
      idempotencyKey: { type: 'string' },
    },
  },
} as const;

export interface ProposalToolInput {
  readonly intentId: string;
  readonly symbol: string;
  readonly targetBaseQtyAtoms: string;
  readonly maxBuyPrice: string | null;
  readonly minSellPrice: string | null;
  readonly maxQuoteDebitAtoms: string;
  readonly expiresAt: string;
  readonly strategyRevision: string;
  readonly policyVersion: string;
  readonly idempotencyKey: string;
}

const PROPOSAL_KEYS = new Set([
  'intentId',
  'symbol',
  'targetBaseQtyAtoms',
  'maxBuyPrice',
  'minSellPrice',
  'maxQuoteDebitAtoms',
  'expiresAt',
  'strategyRevision',
  'policyVersion',
  'idempotencyKey',
]);

function validateProposal(input: unknown): ProposalToolInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('proposal input must be an object');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PROPOSAL_KEYS.has(key)) throw new TypeError(`unknown proposal field ${key}`);
  }
  const stringFields = [
    'intentId',
    'symbol',
    'targetBaseQtyAtoms',
    'maxQuoteDebitAtoms',
    'expiresAt',
    'strategyRevision',
    'policyVersion',
    'idempotencyKey',
  ] as const;
  for (const key of stringFields) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      throw new TypeError(`${key} must be a nonempty string`);
    }
  }
  if (
    (record['maxBuyPrice'] !== null && typeof record['maxBuyPrice'] !== 'string') ||
    (record['minSellPrice'] !== null && typeof record['minSellPrice'] !== 'string')
  ) {
    throw new TypeError('price limits must be strings or null');
  }
  if (!/^(0|[1-9][0-9]{0,77})$/.test(record['targetBaseQtyAtoms'] as string)) {
    throw new TypeError('targetBaseQtyAtoms must be canonical atoms');
  }
  return record as unknown as ProposalToolInput;
}

function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('tool input must be an object');
  }
  const record = input as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new TypeError(`unknown tool field ${unexpected}`);
  return record;
}

/** A router permanently bound to one credential identity and API origin. */
export class ProposalToolRouter {
  constructor(
    private readonly client: Pick<
      CapitalDeskClient,
      'strategyProgress' | 'strategyPlan' | 'strategyIntents' | 'proposeTarget'
    >,
    private readonly scope: {
      readonly workspaceId: string;
      readonly poolId: string;
      readonly strategyId: string;
    },
  ) {}

  async call(tool: string, input: unknown): Promise<unknown> {
    if (!CAPITALDESK_AGENT_TOOLS.includes(tool as CapitalDeskAgentTool)) {
      throw new TypeError(`unsupported CapitalDesk agent tool ${tool}`);
    }
    switch (tool as CapitalDeskAgentTool) {
      case 'get_pool_state':
        fields(input, []);
        return this.client.strategyProgress(
          this.scope.workspaceId,
          this.scope.poolId,
          this.scope.strategyId,
        );
      case 'get_strategy_allocation':
        fields(input, []);
        return this.client.strategyProgress(
          this.scope.workspaceId,
          this.scope.poolId,
          this.scope.strategyId,
        );
      case 'get_market_snapshot': {
        const value = fields(input, ['symbol']);
        if (typeof value['symbol'] !== 'string') throw new TypeError('symbol is required');
        throw new TypeError('market snapshot tool requires the verified read adapter integration');
      }
      case 'get_intent_status': {
        const value = fields(input, ['intentId']);
        if (typeof value['intentId'] !== 'string') throw new TypeError('intentId is required');
        const result = (await this.client.strategyIntents(
          this.scope.workspaceId,
          this.scope.poolId,
          this.scope.strategyId,
        )) as { readonly intents?: readonly { readonly intentId?: string }[] };
        return result.intents?.find((intent) => intent.intentId === value['intentId']) ?? null;
      }
      case 'get_plan_status': {
        const value = fields(input, ['planId']);
        if (typeof value['planId'] !== 'string') throw new TypeError('planId is required');
        return this.client.strategyPlan(
          this.scope.workspaceId,
          this.scope.poolId,
          this.scope.strategyId,
          value['planId'],
        );
      }
      case 'propose_target_position': {
        const proposal = validateProposal(input);
        const { idempotencyKey, ...body } = proposal;
        return this.client.proposeTarget({
          ...this.scope,
          idempotencyKey,
          proposal: body,
        });
      }
    }
  }
}
