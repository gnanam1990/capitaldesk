/**
 * @capitaldesk/contracts — layer 0.
 *
 * Frozen money types, identities, state machines, reason codes, canonical encoding and the
 * approval digest. This package imports nothing from inside CapitalDesk and must never
 * acquire a database, network or filesystem dependency.
 */
export * from './errors.js';
export * from './reason-codes.js';
export * from './time.js';
export * from './money.js';
export * from './price.js';
export * from './marked-value.js';
export * from './identity.js';
export * from './states.js';
export * from './canonical.js';
export * from './plan-digest.js';
export * from './dispatch-envelope.js';
export * from './fee-policy.js';
export * from './observation.js';
export * from './risk.js';
export * from './credentials.js';
export * from './lifecycle.js';

/** Wire contract version. A breaking change requires an ADR and a coordinated bump. */
export const CONTRACTS_VERSION = '1.1.0-amended';
