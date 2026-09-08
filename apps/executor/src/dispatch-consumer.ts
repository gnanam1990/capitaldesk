import type { DispatchAttemptState } from '@capitaldesk/contracts';
import {
  parseSignedOrderRequest,
  OneShotTradeTransmitter,
  type TradeResult,
} from './binance-write.js';

interface DispatchJournal {
  attempt(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly attemptId: string;
  }): Promise<{
    readonly state: DispatchAttemptState;
    readonly clientOrderId: string;
    readonly markedAt: Date | null;
    readonly sendAttemptedAt: Date | null;
    readonly signedRequest: unknown;
  } | null>;
  recordSendAttempted(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly attemptId: string;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: 'NOT_MARKED' }>;
  resolve(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly attemptId: string;
    readonly to: 'ACKNOWLEDGED' | 'REJECTED' | 'UNKNOWN';
  }): Promise<{ readonly ok: boolean }>;
}

interface DispatchOutbox {
  claim(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly consumerId: string;
    readonly leaseMs: number;
  }): Promise<{
    readonly outboxId: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly attempt: number;
  } | null>;
  acknowledge(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly outboxId: string;
    readonly consumerId: string;
  }): Promise<{ readonly ok: boolean }>;
  fail(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly outboxId: string;
    readonly consumerId: string;
    readonly reason: string;
  }): Promise<{ readonly kind: string }>;
}

export type DispatchCycleResult =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'PROCESSED'; readonly attemptId: string; readonly result: TradeResult }
  | { readonly kind: 'NEEDS_ATTENTION'; readonly reason: string };

function attemptIdOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const attemptId = (payload as { readonly attemptId?: unknown }).attemptId;
  return typeof attemptId === 'string' && attemptId.length > 0 ? attemptId : null;
}

/**
 * Consumes the single-attempt dispatch outbox. The sender has neither a signer nor a key.
 * A completed socket call is always followed by a durable terminal/UNKNOWN classification,
 * and the message is acknowledged only after that journal transition commits.
 */
export class DispatchConsumer {
  constructor(
    private readonly journal: DispatchJournal,
    private readonly outbox: DispatchOutbox,
    private readonly transmitter: OneShotTradeTransmitter,
    private readonly consumerId: string,
    private readonly leaseMs: number,
  ) {}

  async runOne(scope: {
    readonly workspaceId: string;
    readonly poolId: string;
  }): Promise<DispatchCycleResult> {
    const message = await this.outbox.claim({
      ...scope,
      consumerId: this.consumerId,
      leaseMs: this.leaseMs,
    });
    if (message === null) return { kind: 'IDLE' };

    const attemptId = message.kind === 'dispatch.send' ? attemptIdOf(message.payload) : null;
    if (attemptId === null || message.attempt !== 1) {
      await this.outbox.fail({
        ...scope,
        outboxId: message.outboxId,
        consumerId: this.consumerId,
        reason: 'malformed or repeated dispatch message',
      });
      return { kind: 'NEEDS_ATTENTION', reason: 'malformed or repeated dispatch message' };
    }

    const attempt = await this.journal.attempt({ ...scope, attemptId });
    if (attempt?.state !== 'DISPATCH_MARKED' || attempt.signedRequest === null) {
      await this.outbox.fail({
        ...scope,
        outboxId: message.outboxId,
        consumerId: this.consumerId,
        reason: 'dispatch message is not bound to one marked signed request',
      });
      return {
        kind: 'NEEDS_ATTENTION',
        reason: 'dispatch message is not bound to one marked signed request',
      };
    }

    let request;
    try {
      request = parseSignedOrderRequest(attempt.signedRequest);
    } catch {
      await this.outbox.fail({
        ...scope,
        outboxId: message.outboxId,
        consumerId: this.consumerId,
        reason: 'marked signed request failed structural validation',
      });
      return { kind: 'NEEDS_ATTENTION', reason: 'marked signed request failed validation' };
    }

    const result = await this.transmitter.send(request, async () => {
      const recorded = await this.journal.recordSendAttempted({ ...scope, attemptId });
      return recorded.ok;
    });
    const resolved = await this.journal.resolve({ ...scope, attemptId, to: result.kind });
    if (!resolved.ok) {
      await this.outbox.fail({
        ...scope,
        outboxId: message.outboxId,
        consumerId: this.consumerId,
        reason: `dispatch outcome ${result.kind} could not be journalled`,
      });
      return { kind: 'NEEDS_ATTENTION', reason: 'dispatch outcome could not be journalled' };
    }
    const acknowledged = await this.outbox.acknowledge({
      ...scope,
      outboxId: message.outboxId,
      consumerId: this.consumerId,
    });
    if (!acknowledged.ok) {
      return { kind: 'NEEDS_ATTENTION', reason: 'dispatch outbox lease was lost after resolution' };
    }
    return { kind: 'PROCESSED', attemptId, result };
  }
}
