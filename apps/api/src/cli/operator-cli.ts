import { readFile } from 'node:fs/promises';
import { CapitalDeskClient, CapitalDeskHttpError } from '@capitaldesk/sdk';
import { parseOperatorArgs } from './operator-args.js';

async function authorizationFromReference(): Promise<string | undefined> {
  const reference = process.env['CAPITALDESK_OPERATOR_AUTH_REF'];
  if (reference === undefined) return undefined;
  const url = new URL(reference);
  if (url.protocol !== 'file:') throw new TypeError('operator auth reference must use file://');
  return (await readFile(url, 'utf8')).trim();
}

async function run(): Promise<unknown> {
  const command = parseOperatorArgs(process.argv.slice(2));
  const baseUrl = process.env['CAPITALDESK_API_URL'] ?? 'http://127.0.0.1:3000';
  if (command.kind === 'doctor') {
    const response = await fetch(new URL('/health/ready', baseUrl));
    const body = await response.json();
    if (!response.ok) throw new CapitalDeskHttpError(response.status, body);
    return body;
  }
  const authorization = await authorizationFromReference();
  const client = new CapitalDeskClient({
    baseUrl,
    ...(authorization === undefined ? {} : { authorization }),
  });
  switch (command.kind) {
    case 'pool':
      return client.pool(command.workspaceId, command.poolId);
    case 'plans':
      return client.plans(command.workspaceId, command.poolId);
    case 'ledger':
      return client.ledger(command.workspaceId, command.poolId);
    case 'approve':
      return client.approve({
        workspaceId: command.workspaceId,
        poolId: command.poolId,
        planId: command.planId,
        planDigest: command.digest,
        executionMode: command.executionMode,
        idempotencyKey: command.idempotencyKey,
      });
    case 'reconcile':
      return client.reconcile(command);
  }
}

try {
  process.stdout.write(`${JSON.stringify(await run())}\n`);
} catch (error) {
  const body =
    error instanceof CapitalDeskHttpError
      ? { error: 'HTTP_ERROR', status: error.status, detail: error.body }
      : { error: 'CLI_ERROR', message: error instanceof Error ? error.message : 'unknown failure' };
  process.stderr.write(`${JSON.stringify(body)}\n`);
  process.exitCode = error instanceof CapitalDeskHttpError ? 3 : 2;
}
