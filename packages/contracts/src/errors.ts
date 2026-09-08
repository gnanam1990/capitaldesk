import type { ReasonCode } from './reason-codes.js';

/**
 * A violation of a frozen contract. Every failure carries a stable reason code so
 * callers, tests and the owner-facing UI describe the same fact (TDD section 11).
 */
export class ContractViolation extends Error {
  readonly reason: ReasonCode;
  readonly detail: Readonly<Record<string, string>>;

  constructor(reason: ReasonCode, message: string, detail: Readonly<Record<string, string>> = {}) {
    super(`${reason}: ${message}`);
    this.name = 'ContractViolation';
    this.reason = reason;
    this.detail = detail;
  }
}

export function violate(
  reason: ReasonCode,
  message: string,
  detail?: Readonly<Record<string, string>>,
): never {
  throw new ContractViolation(reason, message, detail);
}
