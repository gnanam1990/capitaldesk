import { describe, expect, it } from 'vitest';
import { openApiDocument } from './openapi.js';

describe('public OpenAPI surface', () => {
  it('documents operational routes and never exposes signing or generic venue writes', () => {
    const document = openApiDocument();
    const paths = Object.keys(document['paths'] as Record<string, unknown>);
    expect(paths).toContain('/v1/workspaces/{workspaceId}/pools/{poolId}/events');
    expect(paths).toContain('/v1/workspaces/{workspaceId}/pools/{poolId}/reconcile');
    expect(paths.some((path) => /placeOrder|sign|rpc|dispatch/i.test(path))).toBe(false);
    expect(document['x-capitaldesk-examples']).toMatchObject({
      label: 'DOCUMENTATION_EXAMPLES_ONLY',
      outcomes: ['UNKNOWN', 'CONFLICT', 'PARTIAL', 'DEGRADED', 'DENIED'],
    });
  });
});
