/**
 * Resolve the browser-visible configuration a Next command runs with.
 *
 * Pure: takes the values it is given and returns either the environment to run with or the
 * refusal, so the precedence rules can be tested without a filesystem or a process.
 *
 * Precedence, highest first:
 *   1. the explicit process environment (what CI or an operator set on the command line);
 *   2. Next's own env files (.env.local and friends), loaded by the caller with @next/env;
 *   3. local defaults — and only when the declared environment is `local`.
 *
 * `NEXT_PUBLIC_CAPITALDESK_BUILD_ID` takes `CAPITALDESK_BUILD_ID` when it is absent, so a CI
 * build stamped with a commit SHA for the API stamps the console with the same SHA instead of
 * the local default `dev`, which the console would then report as a mismatch against the API.
 */
export const LOCAL_DEFAULTS = Object.freeze({
  NEXT_PUBLIC_CAPITALDESK_ENV: 'local',
  NEXT_PUBLIC_CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-local',
  NEXT_PUBLIC_CAPITALDESK_BASELINE_EPOCH: '1',
  NEXT_PUBLIC_CAPITALDESK_BUILD_ID: 'dev',
  NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'http://127.0.0.1:3000',
});

const REQUIRED = Object.keys(LOCAL_DEFAULTS);

function present(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * @param {{ explicit: Record<string, string|undefined>, loadedFiles: Record<string, string|undefined> }} input
 * @returns {{ ok: true, env: Record<string, string>, applied: string[] } | { ok: false, declared: string, missing: string[] }}
 */
export function resolveBuildEnv({ explicit, loadedFiles }) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const source of [loadedFiles, explicit]) {
    for (const [name, value] of Object.entries(source)) {
      if (present(value)) env[name] = value;
    }
  }

  if (!present(env.NEXT_PUBLIC_CAPITALDESK_BUILD_ID) && present(env.CAPITALDESK_BUILD_ID)) {
    env.NEXT_PUBLIC_CAPITALDESK_BUILD_ID = env.CAPITALDESK_BUILD_ID;
  }

  const declared = env.CAPITALDESK_ENV ?? env.NEXT_PUBLIC_CAPITALDESK_ENV ?? 'local';
  const applied = [];
  if (declared === 'local') {
    for (const [name, value] of Object.entries(LOCAL_DEFAULTS)) {
      if (!present(env[name])) {
        env[name] = value;
        applied.push(name);
      }
    }
    return { ok: true, env, applied };
  }

  const missing = REQUIRED.filter((name) => !present(env[name]));
  if (missing.length > 0) return { ok: false, declared, missing };
  return { ok: true, env, applied };
}
