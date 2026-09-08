import { describe, expect, it } from 'vitest';
import { ContractViolation } from './errors.js';
import { assertOnlyKnownKeys, canonicalJson, digestOf, isDigest } from './canonical.js';

describe('canonical encoding', () => {
  it('orders object keys independently of insertion order', () => {
    expect(canonicalJson({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}');
    expect(canonicalJson({ a: '1', b: '2' })).toBe(canonicalJson({ b: '2', a: '1' }));
  });

  it('produces a stable sha256 digest of the canonical bytes', () => {
    const digest = digestOf({ a: '1', b: ['x', 'y'] });
    expect(isDigest(digest)).toBe(true);
    expect(digest).toBe(digestOf({ b: ['x', 'y'], a: '1' }));
  });

  it('refuses JSON numbers so a quantity can never lose precision silently', () => {
    expect(() => canonicalJson({ atoms: 1 })).toThrow(ContractViolation);
    expect(() => canonicalJson({ atoms: 0.1 })).toThrow(/CANONICAL_ENCODING_REJECTED/);
  });

  it('refuses bigint, undefined, functions and class instances', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(/CANONICAL_ENCODING_REJECTED/);
    expect(() => canonicalJson({ a: undefined })).toThrow(/CANONICAL_ENCODING_REJECTED/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/CANONICAL_ENCODING_REJECTED/);
    expect(() => canonicalJson({ a: new Date() })).toThrow(/CANONICAL_ENCODING_REJECTED/);
  });

  it('refuses cyclic payloads instead of recursing', () => {
    const cyclic: Record<string, unknown> = { a: '1' };
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/acyclic/);
  });

  // --- regression: maintainer draft review, sparse arrays -----------------------------
  // A sparse array previously encoded by dropping its holes, so `new Array(1)` and `[]`
  // shared a digest, and `new Array(2)` produced the string "[,]" which is not valid JSON.
  // Two different payloads sharing one digest breaks INV-08 directly.
  describe('sparse arrays (regression: draft review)', () => {
    it('refuses a single-hole array instead of encoding it as an empty array', () => {
      expect(() => canonicalJson(new Array(1))).toThrow(/sparse arrays/);
    });

    it('refuses a multi-hole array instead of emitting invalid JSON', () => {
      expect(() => canonicalJson(new Array(2))).toThrow(/sparse arrays/);
    });

    it('refuses a hole in the middle of a populated array', () => {
      const holed = ['a', 'b'];
      // eslint-disable-next-line @typescript-eslint/no-array-delete
      delete holed[0];
      expect(() => canonicalJson(holed)).toThrow(/sparse arrays/);
    });

    it('refuses a hole nested inside an object', () => {
      expect(() => canonicalJson({ allocation: new Array(3) })).toThrow(/sparse arrays/);
    });

    it('still encodes dense arrays, including empty ones', () => {
      expect(canonicalJson([])).toBe('[]');
      expect(canonicalJson(['a', 'b'])).toBe('["a","b"]');
    });

    it('never produces output that fails to parse as JSON', () => {
      for (const value of [[], ['a'], { a: ['b', { c: 'd' }] }, null, 'x', true]) {
        expect(() => JSON.parse(canonicalJson(value))).not.toThrow();
      }
    });
  });

  describe('assertOnlyKnownKeys', () => {
    it('accepts an object whose keys are all allowlisted', () => {
      expect(() => assertOnlyKnownKeys({ a: 1, b: 2 }, ['a', 'b', 'c'], '$')).not.toThrow();
    });

    it('names the unexpected keys it refused', () => {
      expect(() => assertOnlyKnownKeys({ a: 1, sneaky: 2 }, ['a'], '$')).toThrow(/sneaky/);
    });
  });
});
