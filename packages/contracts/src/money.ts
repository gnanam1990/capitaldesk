import { violate } from './errors.js';

/**
 * Exact money and quantity types.
 *
 * Every quantity is a nonnegative integer number of atoms bound to an asset identity
 * (TDD section 4). There is no JavaScript `number` on any money path, no floating point
 * and no implicit cross-asset arithmetic: BTC and USDT are never comparable quantities
 * (INV-02).
 */

/** Maximum supported precision, in decimal digits, for any atom quantity (TDD section 4). */
export const MAX_ATOM_DIGITS = 78;

/** Largest representable atom count. Anything larger is refused, never wrapped or clamped. */
export const MAX_ATOMS: bigint = 10n ** BigInt(MAX_ATOM_DIGITS) - 1n;

const ASSET_CODE_PATTERN = /^[A-Z0-9]{1,20}$/;
const SCALE_VERSION_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ATOM_STRING_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * An asset identity. The scale version pins which verified metadata revision established
 * this asset's accounting scale; the same venue code observed under a different verified
 * scale is a different asset key and cannot be added to it.
 */
export interface AssetKey {
  readonly code: string;
  readonly scaleVersion: string;
}

export function assetKey(code: string, scaleVersion: string): AssetKey {
  if (!ASSET_CODE_PATTERN.test(code)) {
    violate('IDENTITY_MALFORMED', 'asset code must be 1-20 uppercase alphanumerics', { code });
  }
  if (!SCALE_VERSION_PATTERN.test(scaleVersion)) {
    violate('IDENTITY_MALFORMED', 'asset scale version is malformed', { scaleVersion });
  }
  return Object.freeze({ code, scaleVersion });
}

export function formatAssetKey(key: AssetKey): string {
  return `${key.code}@${key.scaleVersion}`;
}

export function parseAssetKey(text: string): AssetKey {
  const at = text.indexOf('@');
  if (at <= 0 || at === text.length - 1) {
    violate('IDENTITY_MALFORMED', 'asset key must be CODE@scaleVersion', { text });
  }
  return assetKey(text.slice(0, at), text.slice(at + 1));
}

export function sameAsset(a: AssetKey, b: AssetKey): boolean {
  return a.code === b.code && a.scaleVersion === b.scaleVersion;
}

/**
 * A nonnegative quantity of one asset. Used for balances, claims, reservations, order
 * quantities, fills and commissions. Signed movements use {@link AssetDelta}.
 */
export interface AssetAmount {
  readonly kind: 'AssetAmount';
  readonly asset: AssetKey;
  readonly atoms: bigint;
}

/** A signed ledger movement of one asset. Ledger postings sum to zero within each asset. */
export interface AssetDelta {
  readonly kind: 'AssetDelta';
  readonly asset: AssetKey;
  readonly atoms: bigint;
}

function checkMagnitude(atoms: bigint): void {
  const magnitude = atoms < 0n ? -atoms : atoms;
  if (magnitude > MAX_ATOMS) {
    violate('MONEY_PRECISION_EXCEEDED', `atom magnitude exceeds ${MAX_ATOM_DIGITS} digits`, {
      atoms: atoms.toString(),
    });
  }
}

export function parseAtoms(text: string): bigint {
  // Length is checked before BigInt parsing: a caller-supplied digit string of arbitrary
  // length would otherwise be converted first and rejected afterwards, making the cost of
  // rejecting an oversized value grow with the attacker-chosen input.
  if (text.length > MAX_ATOM_DIGITS) {
    violate('MONEY_PRECISION_EXCEEDED', `atom string exceeds ${MAX_ATOM_DIGITS} digits`, {
      length: String(text.length),
    });
  }
  if (!ATOM_STRING_PATTERN.test(text)) {
    violate(
      'MONEY_NOT_AN_INTEGER',
      'atom strings are canonical nonnegative integers without sign, exponent or leading zero',
      { text },
    );
  }
  const atoms = BigInt(text);
  checkMagnitude(atoms);
  return atoms;
}

export function amount(asset: AssetKey, atoms: bigint | string): AssetAmount {
  const value = typeof atoms === 'string' ? parseAtoms(atoms) : atoms;
  if (typeof atoms !== 'string') {
    if (value < 0n) {
      violate('MONEY_NEGATIVE_RESULT', 'AssetAmount is nonnegative; use delta() for movements', {
        atoms: value.toString(),
      });
    }
    checkMagnitude(value);
  }
  return Object.freeze({ kind: 'AssetAmount' as const, asset, atoms: value });
}

export function zero(asset: AssetKey): AssetAmount {
  return amount(asset, 0n);
}

export function delta(asset: AssetKey, atoms: bigint): AssetDelta {
  checkMagnitude(atoms);
  return Object.freeze({ kind: 'AssetDelta' as const, asset, atoms });
}

function requireSameAsset(a: AssetAmount, b: AssetAmount): void {
  if (!sameAsset(a.asset, b.asset)) {
    violate('MONEY_ASSET_MISMATCH', 'quantities of different assets are never comparable', {
      left: formatAssetKey(a.asset),
      right: formatAssetKey(b.asset),
    });
  }
}

export function addAmounts(a: AssetAmount, b: AssetAmount): AssetAmount {
  requireSameAsset(a, b);
  return amount(a.asset, a.atoms + b.atoms);
}

/** Subtraction that refuses to produce a negative claim (INV-03). */
export function subtractAmounts(a: AssetAmount, b: AssetAmount): AssetAmount {
  requireSameAsset(a, b);
  const result = a.atoms - b.atoms;
  if (result < 0n) {
    violate('MONEY_NEGATIVE_RESULT', 'subtraction would produce a negative quantity', {
      asset: formatAssetKey(a.asset),
      minuend: a.atoms.toString(),
      subtrahend: b.atoms.toString(),
    });
  }
  return amount(a.asset, result);
}

export function compareAmounts(a: AssetAmount, b: AssetAmount): -1 | 0 | 1 {
  requireSameAsset(a, b);
  if (a.atoms < b.atoms) return -1;
  if (a.atoms > b.atoms) return 1;
  return 0;
}

export function minAmount(a: AssetAmount, b: AssetAmount): AssetAmount {
  return compareAmounts(a, b) <= 0 ? a : b;
}

export function maxAmount(a: AssetAmount, b: AssetAmount): AssetAmount {
  return compareAmounts(a, b) >= 0 ? a : b;
}

export function isZero(a: AssetAmount): boolean {
  return a.atoms === 0n;
}

/** Scaling by an exact nonnegative integer count, e.g. a per-unit ceiling times a count. */
export function multiplyAmountByInteger(a: AssetAmount, factor: bigint): AssetAmount {
  if (factor < 0n) {
    violate('MONEY_NEGATIVE_RESULT', 'integer factor must be nonnegative', {
      factor: factor.toString(),
    });
  }
  return amount(a.asset, a.atoms * factor);
}

export function sumAmounts(asset: AssetKey, values: readonly AssetAmount[]): AssetAmount {
  return values.reduce<AssetAmount>((acc, value) => addAmounts(acc, value), zero(asset));
}

/** Canonical wire form: an atom string plus the explicit asset identity and scale version. */
export interface AssetAmountWire {
  readonly asset: string;
  readonly atoms: string;
}

export function encodeAmount(value: AssetAmount): AssetAmountWire {
  return { asset: formatAssetKey(value.asset), atoms: value.atoms.toString() };
}

export function decodeAmount(wire: AssetAmountWire): AssetAmount {
  return amount(parseAssetKey(wire.asset), parseAtoms(wire.atoms));
}
