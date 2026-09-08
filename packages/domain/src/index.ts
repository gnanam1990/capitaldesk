/**
 * @capitaldesk/domain — layer 1.
 *
 * Pure permission model. Depends only on contracts, performs no I/O, and holds no state:
 * every decision is a function of an authenticated principal and a requested scope.
 */
export * from './capabilities.js';
export * from './principal.js';
export * from './strategy-intent.js';
