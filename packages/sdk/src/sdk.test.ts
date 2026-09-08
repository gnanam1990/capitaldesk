import { describe, expect, it, vi } from 'vitest';
import { CapitalDeskClient } from './client.js';
import { verifyEvidenceManifest } from './verifier.js';

describe('CapitalDesk SDK', () => {
  it('does not retry an economic write and preserves the exact idempotency key', async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('response lost'));
    const client = new CapitalDeskClient({ baseUrl: 'http://127.0.0.1:3000', fetch: send });
    await expect(
      client.approve({
        workspaceId: 'ws-1',
        poolId: 'pool-1',
        planId: 'plan-1',
        planDigest: `sha256:${'1'.repeat(64)}`,
        executionMode: 'BROKER_KEY',
        idempotencyKey: 'approve-1',
      }),
    ).rejects.toThrow('response lost');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]?.headers).toMatchObject({ 'idempotency-key': 'approve-1' });
  });

  it('preserves UNKNOWN-like states instead of translating them to failure', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ plans: [{ planId: 'p', state: 'MANUAL_REVIEW' }], nextCursor: null }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const client = new CapitalDeskClient({ baseUrl: 'http://127.0.0.1:3000', fetch: send });
    await expect(client.plans('ws', 'pool')).resolves.toEqual({
      plans: [{ planId: 'p', state: 'MANUAL_REVIEW' }],
      nextCursor: null,
    });
  });

  it('independently detects allocation and actual-fee mismatches', () => {
    const verified = verifyEvidenceManifest({
      planDigest: `sha256:${'a'.repeat(64)}`,
      accountingState: 'RECONCILED',
      grossFilledBaseAtoms: '10',
      allocations: [
        { strategyId: 'a', grossBaseAtoms: '6', commissions: [{ asset: 'BNB@v1', atoms: '1' }] },
        { strategyId: 'b', grossBaseAtoms: '3', commissions: [{ asset: 'BNB@v1', atoms: '1' }] },
      ],
      sourceCommissions: [{ asset: 'BNB@v1', atoms: '3' }],
    });
    expect(verified.valid).toBe(false);
    expect(verified.errors).toContain('allocated gross base does not equal source gross fill');
    expect(verified.errors).toContain('commission total differs for BNB@v1');
  });
});
