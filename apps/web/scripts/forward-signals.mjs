/**
 * Run a child under the same signal-forwarding contract `with-env.mjs` applies to Next.
 *
 * The forwarding logic is duplicated deliberately in one place and imported by both, so a
 * test can exercise it against a child it controls rather than against Next's own handling.
 */
import { spawn } from 'node:child_process';
import { forwardSignalsTo } from './forward.mjs';

const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit', shell: false });
forwardSignalsTo(child);
