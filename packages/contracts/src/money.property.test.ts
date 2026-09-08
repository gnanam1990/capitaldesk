import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_ATOMS,
  addAmounts,
  amount,
  assetKey,
  compareAmounts,
  decodeAmount,
  encodeAmount,
  subtractAmounts,
  sumAmounts,
} from './money.js';
import { canonicalJson, digestOf } from './canonical.js';
import { priceFromDecimal, quoteAtomsForBase } from './price.js';
import { poolConcentration, ratioLimit, type ValuedClaim } from './risk.js';

/**
 * Property evidence. Seeds are recorded by fast-check on failure and any counterexample is
 * minimised and retained as a regression fixture (TEST-PLAN section 2).
 *
 * These are deterministic reference-model properties over pure functions. They are not
 * integration or venue evidence.
 */
const SEED = 20260908;
fc.configureGlobal({ seed: SEED, numRuns: 500 });

const BTC = assetKey('BTC', 'binance-spot-2026-09-08');
const USDT = assetKey('USDT', 'binance-spot-2026-09-08');

/** Atom counts inside the supported precision, biased toward boundaries. */
const atoms = fc.oneof(
  fc.bigInt({ min: 0n, max: 1_000_000n }),
  fc.bigInt({ min: 0n, max: MAX_ATOMS }),
  fc.constantFrom(0n, 1n, MAX_ATOMS, MAX_ATOMS - 1n),
);

describe('money properties', () => {
  it('addition is commutative and associative within one asset', () => {
    fc.assert(
      fc.property(atoms, atoms, atoms, (a, b, c) => {
        if (a + b + c > MAX_ATOMS) return true;
        const x = amount(BTC, a);
        const y = amount(BTC, b);
        const z = amount(BTC, c);
        expect(addAmounts(x, y).atoms).toBe(addAmounts(y, x).atoms);
        expect(addAmounts(addAmounts(x, y), z).atoms).toBe(addAmounts(x, addAmounts(y, z)).atoms);
        return true;
      }),
    );
  });

  it('subtraction inverts addition, and never yields a negative claim', () => {
    fc.assert(
      fc.property(atoms, atoms, (a, b) => {
        if (a + b > MAX_ATOMS) return true;
        const total = addAmounts(amount(BTC, a), amount(BTC, b));
        expect(subtractAmounts(total, amount(BTC, b)).atoms).toBe(a);
        if (b > a) {
          expect(() => subtractAmounts(amount(BTC, a), amount(BTC, b))).toThrow(
            /MONEY_NEGATIVE_RESULT/,
          );
        }
        return true;
      }),
    );
  });

  it('summing a list equals folding it, in any order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { maxLength: 40 }),
        (values) => {
          const forward = sumAmounts(
            BTC,
            values.map((v) => amount(BTC, v)),
          );
          const reversed = sumAmounts(
            BTC,
            [...values].reverse().map((v) => amount(BTC, v)),
          );
          expect(forward.atoms).toBe(reversed.atoms);
          expect(forward.atoms).toBe(values.reduce((s, v) => s + v, 0n));
          return true;
        },
      ),
    );
  });

  it('the wire encoding round-trips exactly', () => {
    fc.assert(
      fc.property(atoms, (a) => {
        const value = amount(USDT, a);
        expect(decodeAmount(encodeAmount(value)).atoms).toBe(value.atoms);
        return true;
      }),
    );
  });

  it('comparison is a total order consistent with bigint ordering', () => {
    fc.assert(
      fc.property(atoms, atoms, (a, b) => {
        const expected = a < b ? -1 : a > b ? 1 : 0;
        expect(compareAmounts(amount(BTC, a), amount(BTC, b))).toBe(expected);
        return true;
      }),
    );
  });
});

describe('price conversion properties', () => {
  const scales = fc.integer({ min: 0, max: 12 });
  const priceText = fc
    .tuple(fc.integer({ min: 1, max: 99_999 }), fc.integer({ min: 0, max: 99_999_999 }))
    .map(([whole, frac]) => `${whole}.${frac.toString().padStart(8, '0')}`);

  it('CEIL is never below FLOOR, and they differ by at most one atom', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 14n }),
        scales,
        scales,
        priceText,
        (base, baseScale, quoteScale, text) => {
          const price = priceFromDecimal(BTC, USDT, text);
          const floor = quoteAtomsForBase(price, base, baseScale, quoteScale, 'FLOOR');
          const ceil = quoteAtomsForBase(price, base, baseScale, quoteScale, 'CEIL');
          expect(ceil).toBeGreaterThanOrEqual(floor);
          expect(ceil - floor).toBeLessThanOrEqual(1n);
          return true;
        },
      ),
    );
  });

  it('conversion is monotonic in quantity', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        priceText,
        (a, b, text) => {
          const price = priceFromDecimal(BTC, USDT, text);
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(quoteAtomsForBase(price, lo, 8, 8, 'FLOOR')).toBeLessThanOrEqual(
            quoteAtomsForBase(price, hi, 8, 8, 'FLOOR'),
          );
          return true;
        },
      ),
    );
  });

  it('a reservation ceiling always covers the exact cost', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), priceText, (base, text) => {
        const price = priceFromDecimal(BTC, USDT, text);
        // A ceiling that ever came in under the floor would under-reserve a real debit.
        expect(quoteAtomsForBase(price, base, 8, 8, 'CEIL')).toBeGreaterThanOrEqual(
          quoteAtomsForBase(price, base, 8, 8, 'FLOOR'),
        );
        return true;
      }),
    );
  });
});

describe('canonical encoding properties', () => {
  const canonical = fc.letrec((tie) => ({
    value: fc.oneof(
      { depthSize: 'small' },
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.array(tie('value'), { maxLength: 5 }),
      fc.dictionary(fc.string({ minLength: 1 }), tie('value'), { maxKeys: 5 }),
    ),
  })).value;

  it('is independent of object key insertion order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.string(), { maxKeys: 8 }),
        (obj) => {
          const reordered = Object.fromEntries(Object.entries(obj).reverse());
          expect(canonicalJson(reordered)).toBe(canonicalJson(obj));
          expect(digestOf(reordered)).toBe(digestOf(obj));
          return true;
        },
      ),
    );
  });

  it('always produces parseable JSON that round-trips to the same value', () => {
    fc.assert(
      fc.property(canonical, (value) => {
        const text = canonicalJson(value);
        expect(canonicalJson(JSON.parse(text) as unknown)).toBe(text);
        return true;
      }),
    );
  });

  it('gives different digests to different payloads', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        if (a === b) return true;
        expect(digestOf({ v: a })).not.toBe(digestOf({ v: b }));
        return true;
      }),
    );
  });
});

describe('pool concentration properties', () => {
  const HALF = ratioLimit(1n, 2n);

  it('is invariant under any redistribution of the same holdings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 9n }), { minLength: 1, maxLength: 12 }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        (parts, other) => {
          const claims: ValuedClaim[] = parts.map((value, index) => ({
            ownerId: `s${index}`,
            ownerKind: 'STRATEGY',
            asset: BTC,
            referenceValueAtoms: value,
            valued: true,
          }));
          claims.push({
            ownerId: 'house',
            ownerKind: 'HOUSE',
            asset: USDT,
            referenceValueAtoms: other,
            valued: true,
          });
          const split = poolConcentration(claims, BTC, HALF);

          // Same total exposure, held entirely by one owner.
          const consolidated: ValuedClaim[] = [
            {
              ownerId: 'only',
              ownerKind: 'STRATEGY',
              asset: BTC,
              referenceValueAtoms: parts.reduce((s, v) => s + v, 0n),
              valued: true,
            },
            {
              ownerId: 'house',
              ownerKind: 'HOUSE',
              asset: USDT,
              referenceValueAtoms: other,
              valued: true,
            },
          ];
          expect(poolConcentration(consolidated, BTC, HALF)).toEqual(split);
          return true;
        },
      ),
    );
  });

  it('agrees with an independent rational comparison', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        (exposure, rest) => {
          const claims: ValuedClaim[] = [
            {
              ownerId: 'a',
              ownerKind: 'STRATEGY',
              asset: BTC,
              referenceValueAtoms: exposure,
              valued: true,
            },
            {
              ownerId: 'h',
              ownerKind: 'HOUSE',
              asset: USDT,
              referenceValueAtoms: rest,
              valued: true,
            },
          ];
          const outcome = poolConcentration(claims, BTC, HALF);
          const total = exposure + rest;
          if (total === 0n) {
            expect(outcome.kind).toBe('EMPTY_POOL');
            return true;
          }
          // Independent oracle: 2 * exposure > total  <=>  exposure/total > 1/2.
          expect(outcome.kind).toBe(2n * exposure > total ? 'EXCEEDED' : 'WITHIN_LIMIT');
          return true;
        },
      ),
    );
  });
});
