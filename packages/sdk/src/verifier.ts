export interface EvidenceManifest {
  readonly planDigest: string;
  readonly accountingState: 'INCOMPLETE' | 'PROVISIONAL' | 'RECONCILED' | 'CONFLICT';
  readonly grossFilledBaseAtoms: string;
  readonly allocations: readonly {
    readonly strategyId: string;
    readonly grossBaseAtoms: string;
    readonly commissions: readonly { readonly asset: string; readonly atoms: string }[];
  }[];
  readonly sourceCommissions: readonly { readonly asset: string; readonly atoms: string }[];
}

export interface VerificationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function atoms(value: string, path: string, errors: string[]): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) {
    errors.push(`${path} is not a canonical nonnegative atom string`);
    return 0n;
  }
  return BigInt(value);
}

/** Recalculate conservation from exported rows without trusting its summary flags. */
export function verifyEvidenceManifest(manifest: EvidenceManifest): VerificationResult {
  const errors: string[] = [];
  if (!/^sha256:[0-9a-f]{64}$/.test(manifest.planDigest)) errors.push('planDigest is malformed');
  const gross = atoms(manifest.grossFilledBaseAtoms, 'grossFilledBaseAtoms', errors);
  let allocated = 0n;
  const commission = new Map<string, bigint>();
  for (const [index, allocation] of manifest.allocations.entries()) {
    allocated += atoms(
      allocation.grossBaseAtoms,
      `allocations[${String(index)}].grossBaseAtoms`,
      errors,
    );
    for (const fee of allocation.commissions) {
      commission.set(
        fee.asset,
        (commission.get(fee.asset) ?? 0n) +
          atoms(fee.atoms, `allocations[${String(index)}].commissions`, errors),
      );
    }
  }
  if (allocated !== gross) errors.push('allocated gross base does not equal source gross fill');
  const source = new Map(
    manifest.sourceCommissions.map((fee) => [
      fee.asset,
      atoms(fee.atoms, 'sourceCommissions', errors),
    ]),
  );
  const assets = new Set([...source.keys(), ...commission.keys()]);
  for (const asset of assets) {
    if ((source.get(asset) ?? 0n) !== (commission.get(asset) ?? 0n)) {
      errors.push(`commission total differs for ${asset}`);
    }
  }
  if (manifest.accountingState === 'RECONCILED' && errors.length > 0) {
    errors.push('manifest claims RECONCILED with inconsistent evidence');
  }
  return { valid: errors.length === 0, errors };
}
