import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionSecretError, resolveOwnerSessionSecret } from './session-secret.js';

/**
 * The reference is not the secret.
 *
 * Signing with `file:///run/secrets/owner-session` would give every deployment configured
 * with that conventional path an identical key that an attacker can simply read from the
 * documentation — and the mounted secret would never be read at all.
 */
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function secretFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cd-secret-'));
  created.push(dir);
  const file = path.join(dir, 'owner-session');
  writeFileSync(file, contents, 'utf8');
  return pathToFileURL(file).toString();
}

const VALID = 'fixture-owner-session-secret-not-a-real-value';

describe('owner session secret resolution', () => {
  it('returns the file contents, not the reference', () => {
    const reference = secretFile(VALID);
    const resolved = resolveOwnerSessionSecret(reference);
    expect(resolved).toBe(VALID);
    expect(resolved).not.toBe(reference);
    expect(resolved).not.toContain('file://');
  });

  it('trims the trailing newline an editor or here-doc adds', () => {
    expect(resolveOwnerSessionSecret(secretFile(`${VALID}\n`))).toBe(VALID);
  });

  it('gives different secrets for different file contents, not different paths', () => {
    // The property that matters: the signature follows the contents. Two references that
    // differ only by path but hold the same bytes must resolve identically, and two holding
    // different bytes must differ — which is what a reference-as-key would get backwards.
    const other = `${VALID.slice(0, 31)}Z`;
    expect(resolveOwnerSessionSecret(secretFile(VALID))).toBe(
      resolveOwnerSessionSecret(secretFile(VALID)),
    );
    expect(resolveOwnerSessionSecret(secretFile(other))).not.toBe(
      resolveOwnerSessionSecret(secretFile(VALID)),
    );
  });

  describe('refusals', () => {
    it('refuses a literal secret passed where a reference belongs', () => {
      expect(() => resolveOwnerSessionSecret(VALID)).toThrow(SessionSecretError);
      expect(() => resolveOwnerSessionSecret(VALID)).toThrow(/not a URI/);
    });

    it('refuses an unsupported scheme rather than treating it as a literal', () => {
      for (const reference of [
        'https://vault.example/secret',
        'env://OWNER_SESSION',
        'vault://kv/owner',
      ]) {
        expect(() => resolveOwnerSessionSecret(reference), reference).toThrow(/unsupported scheme/);
      }
    });

    it('refuses a missing file', () => {
      const missing = pathToFileURL(path.join(tmpdir(), 'cd-absent', 'nope')).toString();
      expect(() => resolveOwnerSessionSecret(missing)).toThrow(/cannot read the referenced file/);
    });

    it('refuses an empty file, which is what an unmounted secret looks like', () => {
      expect(() => resolveOwnerSessionSecret(secretFile(''))).toThrow(/empty/);
      expect(() => resolveOwnerSessionSecret(secretFile('   \n'))).toThrow(/empty/);
    });

    it('refuses a secret shorter than the signing minimum', () => {
      expect(() => resolveOwnerSessionSecret(secretFile('short'))).toThrow(/at least 32/);
      expect(() => resolveOwnerSessionSecret(secretFile('a'.repeat(31)))).toThrow(/at least 32/);
    });

    it('refuses a long value with almost no entropy', () => {
      expect(() => resolveOwnerSessionSecret(secretFile('a'.repeat(64)))).toThrow(
        /too few distinct characters/,
      );
    });

    it('refuses an obvious placeholder, whatever its length', () => {
      // These reach REFUSED_PLACEHOLDERS. The earlier version used 8-11 character values, so
      // the length guard threw first and the assertion accepted either message - the
      // placeholder branch was never executed, and would have passed if it were deleted.
      for (const placeholder of ['changeme', 'CHANGEME', 'placeholder', 'password', 'todo']) {
        expect(() => resolveOwnerSessionSecret(secretFile(placeholder)), placeholder).toThrow(
          /placeholder/,
        );
      }
      // A long value that is not a placeholder still fails on entropy, not on this branch.
      expect(() => resolveOwnerSessionSecret(secretFile('a'.repeat(64)))).toThrow(
        /too few distinct characters/,
      );
    });

    it('never puts the resolved content in the error message', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'cd-secret-'));
      created.push(dir);
      const file = path.join(dir, 'owner-session');
      writeFileSync(file, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'utf8');
      try {
        resolveOwnerSessionSecret(pathToFileURL(file).toString());
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as Error).message).not.toContain('aaaaaaaa');
      }
    });

    it('reports an unreadable file as unreadable rather than throwing raw', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'cd-secret-'));
      created.push(dir);
      const file = path.join(dir, 'owner-session');
      writeFileSync(file, VALID, 'utf8');
      chmodSync(file, 0o000);
      try {
        expect(() => resolveOwnerSessionSecret(pathToFileURL(file).toString())).toThrow(
          /cannot read the referenced file/,
        );
      } finally {
        chmodSync(file, 0o600);
      }
    });
  });
});
