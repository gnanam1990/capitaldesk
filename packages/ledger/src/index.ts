/**
 * @capitaldesk/ledger — layer 1.
 *
 * The rules a baseline and an owner allocation must satisfy, and the independent per-asset
 * verification of a projection. Pure: this package performs no I/O and holds no state, so the
 * same predicate answers for a service, a test and an evidence export.
 */
export * from './assets.js';
export * from './allocation.js';
export * from './baseline.js';
export * from './conservation.js';
