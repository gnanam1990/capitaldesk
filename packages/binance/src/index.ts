/**
 * @capitaldesk/binance — layer 1.
 *
 * Read-only Binance Spot readers. This package holds no credential value, performs no write,
 * and cannot express one: there is no generic request method, and a URL can only be built for
 * a named endpoint against a validated origin.
 */
export * from './decode.js';
export * from './endpoints.js';
export * from './failures.js';
export * from './transport.js';
export * from './redaction.js';
