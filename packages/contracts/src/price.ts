import { violate } from './errors.js';
import {
  MAX_ATOMS,
  MAX_ATOM_DIGITS,
  amount,
  formatAssetKey,
  sameAsset,
  type AssetAmount,
  type AssetKey,
} from './money.js';

/**
 * Exact fixed-point prices, and the only sanctioned conversion between a base quantity
 * and a quote quantity.
 *
 * A price is not money: it has no atoms and cannot be added to an AssetAmount. Converting
 * base atoms to quote atoms always states its rounding direction explicitly, because
 * rounding direction is an economic authorization decision (TDD section 6): a reservation
 * ceiling rounds up, an admitted quantity rounds down, and neither is ever chosen by
 * accident.
 */

const MAX_PRICE_DIGITS = 40;
const MAX_PRICE_MANTISSA = 10n ** BigInt(MAX_PRICE_DIGITS) - 1n;
const MIN_PRICE_EXPONENT = -30;
const MAX_PRICE_EXPONENT = 30;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * Accounting scales are decimal places and are therefore nonnegative integers. A negative
 * scale would silently multiply where the caller expected a division, so it is refused
 * rather than interpreted. The upper bound matches the supported asset precision.
 */
const MAX_ACCOUNTING_SCALE = 30;

function requireAccountingScale(name: string, scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_ACCOUNTING_SCALE) {
    violate(
      'MONEY_PRECISION_EXCEEDED',
      `${name} must be an integer number of decimal places between 0 and ${MAX_ACCOUNTING_SCALE}`,
      { [name]: String(scale) },
    );
  }
}

/** Rounding direction. There is no "nearest": every money rounding picks a side on purpose. */
export type Rounding = 'FLOOR' | 'CEIL' | 'EXACT';

/** value = mantissa * 10^exponent, expressed in quote units per one base unit. */
export interface Price {
  readonly kind: 'Price';
  readonly base: AssetKey;
  readonly quote: AssetKey;
  readonly mantissa: bigint;
  readonly exponent: number;
}

/**
 * Strip trailing decimal zeros so one economic price has one representation.
 *
 * `20000` and `20000.00` are the same price. Left unnormalised they format differently, so
 * they produced different approval digests for an identical plan — an owner could approve a
 * plan and have its digest fail to match purely because of how the price was written.
 */
function canonicalise(mantissa: bigint, exponent: number): { mantissa: bigint; exponent: number } {
  if (mantissa === 0n) return { mantissa: 0n, exponent: 0 };
  let m = mantissa;
  let e = exponent;
  while (e < 0 && m % 10n === 0n) {
    m /= 10n;
    e += 1;
  }
  return { mantissa: m, exponent: e };
}

export function price(base: AssetKey, quote: AssetKey, mantissa: bigint, exponent: number): Price {
  if (mantissa < 0n) {
    violate('MONEY_NEGATIVE_RESULT', 'price mantissa must be nonnegative', {
      mantissa: mantissa.toString(),
    });
  }
  if (mantissa > MAX_PRICE_MANTISSA) {
    violate('MONEY_PRECISION_EXCEEDED', `price mantissa exceeds ${MAX_PRICE_DIGITS} digits`, {
      mantissa: mantissa.toString(),
    });
  }
  if (
    !Number.isInteger(exponent) ||
    exponent < MIN_PRICE_EXPONENT ||
    exponent > MAX_PRICE_EXPONENT
  ) {
    violate('MONEY_PRECISION_EXCEEDED', 'price exponent out of supported range', {
      exponent: String(exponent),
    });
  }
  if (sameAsset(base, quote)) {
    violate('MONEY_ASSET_MISMATCH', 'a price cannot quote an asset in itself', {
      asset: formatAssetKey(base),
    });
  }
  const canonical = canonicalise(mantissa, exponent);
  return Object.freeze({
    kind: 'Price' as const,
    base,
    quote,
    mantissa: canonical.mantissa,
    exponent: canonical.exponent,
  });
}

/** Parse an exact decimal string such as "20000" or "19900.55". Never uses binary floats. */
export function priceFromDecimal(base: AssetKey, quote: AssetKey, text: string): Price {
  // Length first, as parseAtoms does: converting a caller-supplied string of arbitrary length
  // and rejecting it afterwards makes the cost of refusal grow with the input.
  if (text.length > MAX_PRICE_DIGITS + MAX_PRICE_EXPONENT + 2) {
    violate('MONEY_PRECISION_EXCEEDED', 'price text is longer than any representable price', {
      length: String(text.length),
    });
  }
  if (!DECIMAL_PATTERN.test(text)) {
    violate('MONEY_NOT_AN_INTEGER', 'price must be an exact nonnegative decimal string', { text });
  }
  const dot = text.indexOf('.');
  if (dot < 0) {
    return price(base, quote, BigInt(text), 0);
  }
  const fraction = text.slice(dot + 1);
  return price(base, quote, BigInt(text.slice(0, dot) + fraction), -fraction.length);
}

export function formatPrice(value: Price): string {
  if (value.exponent >= 0) {
    return (value.mantissa * 10n ** BigInt(value.exponent)).toString();
  }
  const digits = value.mantissa.toString().padStart(-value.exponent + 1, '0');
  const cut = digits.length + value.exponent;
  return `${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

export function comparePrices(a: Price, b: Price): -1 | 0 | 1 {
  if (!sameAsset(a.base, b.base) || !sameAsset(a.quote, b.quote)) {
    violate('MONEY_ASSET_MISMATCH', 'prices of different pairs are not comparable', {
      left: `${formatAssetKey(a.base)}/${formatAssetKey(a.quote)}`,
      right: `${formatAssetKey(b.base)}/${formatAssetKey(b.quote)}`,
    });
  }
  const exponent = Math.min(a.exponent, b.exponent);
  const left = a.mantissa * 10n ** BigInt(a.exponent - exponent);
  const right = b.mantissa * 10n ** BigInt(b.exponent - exponent);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function divide(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  switch (rounding) {
    case 'FLOOR':
      return quotient;
    case 'CEIL':
      return quotient + 1n;
    case 'EXACT':
      return violate(
        'MONEY_INEXACT_CONVERSION',
        'conversion is not exact and no rounding direction was authorized',
        { numerator: numerator.toString(), denominator: denominator.toString() },
      );
  }
}

/**
 * Convert an exact base quantity to quote atoms at this price.
 *
 * `baseScale` and `quoteScale` are the verified accounting scales of the two assets. The
 * result is exact integer arithmetic throughout; the rounding direction only applies to the
 * final division and must be stated by the caller.
 */
export function quoteAtomsForBase(
  value: Price,
  baseAtoms: bigint,
  baseScale: number,
  quoteScale: number,
  rounding: Rounding,
): bigint {
  requireAccountingScale('baseScale', baseScale);
  requireAccountingScale('quoteScale', quoteScale);
  if (baseAtoms < 0n) {
    violate('MONEY_NEGATIVE_RESULT', 'base atoms must be nonnegative', {
      baseAtoms: baseAtoms.toString(),
    });
  }
  if (baseAtoms > MAX_ATOMS) {
    violate('MONEY_PRECISION_EXCEEDED', `base atoms exceed ${MAX_ATOM_DIGITS} digits`, {
      baseAtoms: baseAtoms.toString(),
    });
  }

  const shift = value.exponent - baseScale + quoteScale;
  const product = baseAtoms * value.mantissa;
  const result =
    shift >= 0 ? product * 10n ** BigInt(shift) : divide(product, 10n ** BigInt(-shift), rounding);

  // The result is money, so it obeys the same precision bound as any other quantity. A
  // conversion that overflows it is refused; it is never truncated or wrapped.
  if (result > MAX_ATOMS) {
    violate(
      'MONEY_PRECISION_EXCEEDED',
      `converted quote quantity exceeds ${MAX_ATOM_DIGITS} digits`,
      {
        baseAtoms: baseAtoms.toString(),
        price: formatPrice(value),
        digits: String(result.toString().length),
      },
    );
  }
  return result;
}

/** Typed convenience wrapper returning an {@link AssetAmount} in the quote asset. */
export function quoteAmountForBase(
  value: Price,
  base: AssetAmount,
  baseScale: number,
  quoteScale: number,
  rounding: Rounding,
): AssetAmount {
  if (!sameAsset(base.asset, value.base)) {
    violate('MONEY_ASSET_MISMATCH', 'quantity asset does not match the price base asset', {
      quantity: formatAssetKey(base.asset),
      priceBase: formatAssetKey(value.base),
    });
  }
  return amount(value.quote, quoteAtomsForBase(value, base.atoms, baseScale, quoteScale, rounding));
}
