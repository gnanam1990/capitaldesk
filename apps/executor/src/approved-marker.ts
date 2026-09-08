import { assertEnvelopeWithinApproval, violate } from '@capitaldesk/contracts';
import {
  ApprovalRepository,
  type AuthorizedMarkInput,
  type DispatchRepository,
  type ExecutionMode,
  type MarkOutcome,
} from '@capitaldesk/db';
import {
  BinanceLimitIocSigner,
  type LimitIocOrder,
  type SignedOrderRequest,
} from './binance-write.js';

type CanonicalRecord = Readonly<Record<string, unknown>>;

function record(value: unknown, field: string): CanonicalRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    violate('CANONICAL_ENCODING_REJECTED', `sealed plan ${field} must be an object`);
  }
  return value as CanonicalRecord;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    violate('CANONICAL_ENCODING_REJECTED', `sealed plan ${field} must be a string`);
  }
  return value;
}

function milliseconds(value: unknown, field: string): number {
  const encoded = text(value, field);
  if (!/^(0|[1-9][0-9]*)$/.test(encoded)) {
    violate('CANONICAL_ENCODING_REJECTED', `sealed plan ${field} must be canonical milliseconds`);
  }
  const parsed = Number(encoded);
  if (!Number.isSafeInteger(parsed)) {
    violate('CANONICAL_ENCODING_REJECTED', `sealed plan ${field} exceeds safe milliseconds`);
  }
  return parsed;
}

/** The decimal quantity is derived from venue metadata; its source atoms must match the plan. */
export interface ExecutableOrder extends LimitIocOrder {
  readonly quantityAtoms: string;
}

export function assertOrderMatchesSealedPlan(
  planValue: unknown,
  order: ExecutableOrder,
): {
  readonly approvalExpiresAt: string;
  readonly submissionDeadlineAt: string;
  readonly signedRequestValidityMs: number;
  readonly clockSkewBudgetMs: number;
} {
  const plan = record(planValue, 'payload');
  const gross = record(plan['grossBaseQuantity'], 'grossBaseQuantity');
  const limit = record(plan['limitPrice'], 'limitPrice');
  if (
    text(plan['childClientOrderId'], 'childClientOrderId') !== order.clientOrderId ||
    text(plan['symbol'], 'symbol') !== order.symbol ||
    text(plan['side'], 'side') !== order.side ||
    text(plan['orderType'], 'orderType') !== 'LIMIT' ||
    text(plan['timeInForce'], 'timeInForce') !== 'IOC' ||
    text(gross['atoms'], 'grossBaseQuantity.atoms') !== order.quantityAtoms ||
    text(limit['value'], 'limitPrice.value') !== order.price
  ) {
    violate('APPROVAL_DIGEST_MISMATCH', 'executable order differs from the sealed plan');
  }
  return {
    approvalExpiresAt: text(plan['approvalExpiresAt'], 'approvalExpiresAt'),
    submissionDeadlineAt: text(plan['submissionDeadlineAt'], 'submissionDeadlineAt'),
    signedRequestValidityMs: milliseconds(
      plan['signedRequestValidityMs'],
      'signedRequestValidityMs',
    ),
    clockSkewBudgetMs: milliseconds(plan['clockSkewBudgetMs'], 'clockSkewBudgetMs'),
  };
}

/**
 * Revalidate owner consent and freeze the signed bytes inside the marker transaction.
 * `BROKER_KEY` is the locally executable path. `APPROVED_HOST` remains gated by its durable
 * native confirmation in ApprovalRepository.
 */
export function markApprovedPlan(input: {
  readonly repository: DispatchRepository;
  readonly mark: AuthorizedMarkInput;
  readonly executionMode: ExecutionMode;
  readonly order: ExecutableOrder;
  readonly signer: BinanceLimitIocSigner;
  readonly venueClockOffsetMs: number;
  readonly transmissionLatencyBudgetMs: number;
}): Promise<MarkOutcome> {
  return input.repository.markAuthorized(input.mark, async (context) => {
    const clock = await context.client.query<{ db_now: Date }>(
      'SELECT clock_timestamp() AS db_now',
    );
    const now = clock.rows[0]?.db_now;
    if (now === undefined) return { ok: false, detail: 'DATABASE_CLOCK_UNAVAILABLE' };
    const eligibility = await ApprovalRepository.eligibilityOn(context.client, {
      workspaceId: input.mark.workspaceId,
      poolId: input.mark.poolId,
      planId: context.planId,
      digest: context.planDigest,
      executionMode: input.executionMode,
      now,
    });
    if (!eligibility.ok) return { ok: false, detail: eligibility.reason };
    if (context.clientOrderId !== input.order.clientOrderId) {
      return { ok: false, detail: 'CLIENT_ORDER_ID_MISMATCH' };
    }
    const timing = assertOrderMatchesSealedPlan(context.planPayload, input.order);
    const signedRequest: SignedOrderRequest = input.signer.sign({
      order: input.order,
      signedTimestampMs: now.getTime() + input.venueClockOffsetMs,
      venueClockOffsetMs: input.venueClockOffsetMs,
      validityMs: timing.signedRequestValidityMs,
      clockSkewBudgetMs: timing.clockSkewBudgetMs,
      transmissionLatencyBudgetMs: input.transmissionLatencyBudgetMs,
    });
    assertEnvelopeWithinApproval(
      signedRequest.envelope,
      eligibility.submissionDeadlineAt.toISOString(),
      eligibility.approvalExpiresAt.toISOString(),
    );
    return { ok: true, signedRequest };
  });
}
