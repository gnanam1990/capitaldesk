import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Integration evidence for process lifetime.
 *
 * The defect this covers was invisible to every unit test: the worker logged that it had
 * started and then exited with status 13, because a pending top-level `await` does not keep
 * Node alive. Only spawning the real built entrypoint can catch that, so this test does
 * exactly that rather than asserting on a helper.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = path.join(HERE, '..', 'dist', 'main.js');

const ENV = {
  ...process.env,
  CAPITALDESK_ENV: 'local',
  CAPITALDESK_VENUE: 'binance-spot',
  CAPITALDESK_VENUE_BASE_URL: 'http://127.0.0.1:9443',
  CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-local',
  CAPITALDESK_BASELINE_EPOCH: '1',
  CAPITALDESK_LOG_LEVEL: 'info',
  CAPITALDESK_BUILD_ID: 'lifetime-test',
  DATABASE_URL: 'postgres://localhost:5432/capitaldesk_test',
};

const running: import('node:child_process').ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

function spawnWorker() {
  const child = execFile(process.execPath, [ENTRYPOINT], { env: ENV });
  running.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return { child, stderr: () => stderr };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('worker process lifetime', () => {
  it('stays alive rather than exiting once startup logging flushes', async () => {
    const { child } = spawnWorker();
    await sleep(2500);
    // exitCode null means still running. Before the fix this was 13.
    expect(child.exitCode, 'worker exited instead of idling').toBeNull();
  });

  it('never prints the unsettled top-level await warning', async () => {
    const { stderr } = spawnWorker();
    await sleep(2500);
    expect(stderr()).not.toContain('unsettled top-level await');
  });

  it('exits cleanly on SIGTERM', async () => {
    const { child } = spawnWorker();
    await sleep(1500);
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    expect(await exit).toBe(0);
  });

  // --- regression: PR 1 review, repeat signal killed cleanup ---------------------------
  // With `process.once` the handler is removed as it fires, so a second SIGTERM during
  // asynchronous shutdown reached Node's default handler: exit 143 with cleanup half done.
  it('survives a repeated signal during shutdown and still exits cleanly', async () => {
    const { child } = spawnWorker();
    await sleep(1500);
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await sleep(120);
    child.kill('SIGTERM');
    await sleep(120);
    child.kill('SIGTERM');
    // 143 would mean the default handler terminated the process mid-shutdown.
    expect(await exit).toBe(0);
  });

  it('survives a mixed repeated signal during shutdown', async () => {
    const { child } = spawnWorker();
    await sleep(1500);
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await sleep(120);
    child.kill('SIGINT');
    expect(await exit).toBe(0);
  });

  it('exits cleanly on SIGINT', async () => {
    const { child } = spawnWorker();
    await sleep(1500);
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.kill('SIGINT');
    expect(await exit).toBe(0);
  });
});
