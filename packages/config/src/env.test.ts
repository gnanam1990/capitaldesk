import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  loadApiConfig,
  loadExecutorConfig,
  loadWebPublicConfig,
  loadWorkerConfig,
} from './env.js';

const TESTNET_BASE = {
  CAPITALDESK_ENV: 'testnet',
  CAPITALDESK_VENUE: 'binance-spot',
  CAPITALDESK_VENUE_BASE_URL: 'https://testnet.binance.vision',
  CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-proof',
  CAPITALDESK_BASELINE_EPOCH: '1',
  CAPITALDESK_LOG_LEVEL: 'info',
  CAPITALDESK_BUILD_ID: 'test-build',
  DATABASE_URL: 'postgres://localhost:5432/capitaldesk',
} satisfies NodeJS.ProcessEnv;

const EXECUTOR_BASE = {
  ...TESTNET_BASE,
  CAPITALDESK_WRITE_CAPABILITY: 'disabled',
  CAPITALDESK_SIGNED_REQUEST_VALIDITY_MS: '5000',
  CAPITALDESK_CLOCK_SKEW_BUDGET_MS: '1000',
  CAPITALDESK_AUTHORIZATION_DURABILITY: 'SYNCHRONOUS_REPLICA',
} satisfies NodeJS.ProcessEnv;

const API_BASE = {
  ...TESTNET_BASE,
  CAPITALDESK_API_PORT: '3000',
  CAPITALDESK_OWNER_SESSION_SECRET_REF: 'file:///run/secrets/owner-session',
} satisfies NodeJS.ProcessEnv;

const WEB_BASE = {
  NEXT_PUBLIC_CAPITALDESK_ENV: 'testnet',
  NEXT_PUBLIC_CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-proof',
  NEXT_PUBLIC_CAPITALDESK_BASELINE_EPOCH: '1',
  NEXT_PUBLIC_CAPITALDESK_BUILD_ID: 'test-build',
  NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'http://127.0.0.1:3000',
} satisfies NodeJS.ProcessEnv;

describe('environment contracts', () => {
  describe('a missing or unknown environment is refused', () => {
    it('refuses an empty environment', () => {
      expect(() => loadApiConfig({})).toThrow(ConfigurationError);
    });

    it('refuses an unknown deployment environment', () => {
      expect(() => loadApiConfig({ ...API_BASE, CAPITALDESK_ENV: 'staging' })).toThrow(
        /CAPITALDESK_ENV/,
      );
    });

    it('refuses a missing account alias rather than inventing one', () => {
      const { CAPITALDESK_ACCOUNT_ALIAS: _omitted, ...withoutAlias } = API_BASE;
      expect(() => loadApiConfig(withoutAlias)).toThrow(/CAPITALDESK_ACCOUNT_ALIAS/);
    });

    it('refuses a baseline epoch below 1', () => {
      expect(() => loadApiConfig({ ...API_BASE, CAPITALDESK_BASELINE_EPOCH: '0' })).toThrow(
        /CAPITALDESK_BASELINE_EPOCH/,
      );
    });

    it('accepts a complete testnet API configuration', () => {
      const config = loadApiConfig(API_BASE);
      expect(config.economicEnvironment).toBe('testnet');
      expect(config.httpPort).toBe(3000);
    });
  });

  describe('testnet never falls back to a live host', () => {
    it('refuses the live host in a testnet deployment', () => {
      expect(() =>
        loadApiConfig({ ...API_BASE, CAPITALDESK_VENUE_BASE_URL: 'https://api.binance.com' }),
      ).toThrow(/refusing to route a testnet deployment at a live host/);
    });

    it('refuses a host that is not allowlisted for the environment', () => {
      expect(() =>
        loadApiConfig({ ...API_BASE, CAPITALDESK_VENUE_BASE_URL: 'https://evil.example.com' }),
      ).toThrow(/not allowlisted/);
    });

    it('refuses a testnet host in a production-read-only deployment', () => {
      expect(() =>
        loadApiConfig({
          ...API_BASE,
          CAPITALDESK_ENV: 'production-read-only',
          CAPITALDESK_VENUE_BASE_URL: 'https://testnet.binance.vision',
        }),
      ).toThrow(/not allowlisted/);
    });
  });

  describe('write capability starts disabled', () => {
    it('defaults to nothing: an absent capability is a refusal, not a default', () => {
      const { CAPITALDESK_WRITE_CAPABILITY: _omitted, ...withoutCapability } = EXECUTOR_BASE;
      expect(() => loadExecutorConfig(withoutCapability)).toThrow(/CAPITALDESK_WRITE_CAPABILITY/);
    });

    it('loads a disabled executor without a trade credential', () => {
      expect(loadExecutorConfig(EXECUTOR_BASE).writeCapability).toBe('disabled');
    });

    it('refuses to enable writes without an explicit trade credential reference', () => {
      expect(() =>
        loadExecutorConfig({ ...EXECUTOR_BASE, CAPITALDESK_WRITE_CAPABILITY: 'enabled' }),
      ).toThrow(/requires an explicit trade credential reference/);
    });

    // --- regression: PR 1 review, the restriction was incidental ---------------------
    it('states the permitted environments rather than one forbidden case', () => {
      // testnet is the real target and must keep working.
      expect(
        loadExecutorConfig({
          ...EXECUTOR_BASE,
          CAPITALDESK_WRITE_CAPABILITY: 'enabled',
          CAPITALDESK_TRADE_CREDENTIAL_REF: 'file:///run/secrets/trade',
        }).writeCapability,
      ).toBe('enabled');
    });

    it('can never enable writes in a production-read-only deployment', () => {
      expect(() =>
        loadExecutorConfig({
          ...EXECUTOR_BASE,
          CAPITALDESK_ENV: 'production-read-only',
          CAPITALDESK_VENUE_BASE_URL: 'https://api.binance.com',
          CAPITALDESK_WRITE_CAPABILITY: 'enabled',
          CAPITALDESK_TRADE_CREDENTIAL_REF: 'file:///run/secrets/trade',
        }),
      ).toThrow(/production-read-only can never hold it/);
    });

    it('refuses a skew budget that the signed request window cannot enforce', () => {
      expect(() =>
        loadExecutorConfig({
          ...EXECUTOR_BASE,
          CAPITALDESK_CLOCK_SKEW_BUDGET_MS: '5000',
        }),
      ).toThrow(/smaller than the signed request validity window/);
    });

    it('refuses a recvWindow above the venue maximum', () => {
      expect(() =>
        loadExecutorConfig({ ...EXECUTOR_BASE, CAPITALDESK_SIGNED_REQUEST_VALIDITY_MS: '60001' }),
      ).toThrow(/CAPITALDESK_SIGNED_REQUEST_VALIDITY_MS/);
    });
  });

  describe('credential classes are bound to their process role', () => {
    it('refuses a trade credential mounted into the API', () => {
      expect(() =>
        loadApiConfig({
          ...API_BASE,
          CAPITALDESK_TRADE_CREDENTIAL_REF: 'file:///run/secrets/trade',
        }),
      ).toThrow(/must not be mounted into the api role/);
    });

    it('refuses a trade credential mounted into the worker', () => {
      // The reference, not a raw value: a raw value is refused everywhere by a separate rule.
      expect(() =>
        loadWorkerConfig({
          ...TESTNET_BASE,
          CAPITALDESK_TRADE_CREDENTIAL_REF: 'file:///run/secrets/venue-trade',
        }),
      ).toThrow(/must not be mounted into the worker role/);
    });

    it('refuses a read credential mounted into the executor', () => {
      expect(() =>
        loadExecutorConfig({ ...EXECUTOR_BASE, CAPITALDESK_READ_CREDENTIAL_REF: 'file:///r' }),
      ).toThrow(/must not be mounted into the executor role/);
    });

    it('refuses any venue credential reaching the browser configuration', () => {
      expect(() =>
        loadWebPublicConfig({
          NEXT_PUBLIC_CAPITALDESK_ENV: 'testnet',
          NEXT_PUBLIC_CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-proof',
          NEXT_PUBLIC_CAPITALDESK_BASELINE_EPOCH: '1',
          NEXT_PUBLIC_CAPITALDESK_BUILD_ID: 'test-build',
          NEXT_PUBLIC_CAPITALDESK_API_BASE_URL: 'http://127.0.0.1:3000',
          CAPITALDESK_TRADE_CREDENTIAL_REF: 'file:///run/secrets/trade',
        }),
      ).toThrow(/must not be mounted into the web role/);
    });

    // --- regression: PR 1 review, raw secrets accepted in their owning role -----------
    // Raw value names were grouped with reference names, so a pasted key was legal in
    // exactly the role most likely to receive one.
    describe('a raw secret value is refused in every role', () => {
      const RAW = ['BINANCE_API_SECRET', 'BINANCE_SECRET_KEY', 'BINANCE_READ_API_SECRET'] as const;

      for (const variable of RAW) {
        it(`refuses ${variable} in the executor, which owns the trade credential`, () => {
          expect(() => loadExecutorConfig({ ...EXECUTOR_BASE, [variable]: 'raw' })).toThrow(
            /carries a credential reference, never a secret value/,
          );
        });

        it(`refuses ${variable} in the worker, which owns the read credential`, () => {
          expect(() => loadWorkerConfig({ ...TESTNET_BASE, [variable]: 'raw' })).toThrow(
            /carries a credential reference, never a secret value/,
          );
        });

        it(`refuses ${variable} in the api`, () => {
          expect(() => loadApiConfig({ ...API_BASE, [variable]: 'raw' })).toThrow(
            /carries a credential reference, never a secret value/,
          );
        });
      }

      it('refuses a raw secret reaching the browser configuration', () => {
        expect(() => loadWebPublicConfig({ ...WEB_BASE, BINANCE_API_SECRET: 'raw' })).toThrow(
          /carries a credential reference, never a secret value/,
        );
      });
    });

    describe('only the matching reference is accepted, and only in its owning role', () => {
      it('accepts the trade reference in the executor', () => {
        const config = loadExecutorConfig({
          ...EXECUTOR_BASE,
          CAPITALDESK_WRITE_CAPABILITY: 'enabled',
          CAPITALDESK_TRADE_CREDENTIAL_REF: 'file:///run/secrets/venue-trade',
        });
        expect(config.tradeCredentialRef).toBe('file:///run/secrets/venue-trade');
      });

      it('refuses the trade reference in the worker', () => {
        expect(() =>
          loadWorkerConfig({
            ...TESTNET_BASE,
            CAPITALDESK_TRADE_CREDENTIAL_REF: 'file:///run/secrets/venue-trade',
          }),
        ).toThrow(/must not be mounted into the worker role/);
      });

      it('refuses the read reference in the executor', () => {
        expect(() =>
          loadExecutorConfig({
            ...EXECUTOR_BASE,
            CAPITALDESK_READ_CREDENTIAL_REF: 'file:///run/secrets/venue-read',
          }),
        ).toThrow(/must not be mounted into the executor role/);
      });

      it('refuses either reference in the browser configuration', () => {
        for (const variable of [
          'CAPITALDESK_TRADE_CREDENTIAL_REF',
          'CAPITALDESK_READ_CREDENTIAL_REF',
        ]) {
          expect(
            () => loadWebPublicConfig({ ...WEB_BASE, [variable]: 'file:///x' }),
            variable,
          ).toThrow(/must not be mounted into the web role/);
        }
      });
    });

    it('lets the worker hold a read credential reference', () => {
      const config = loadWorkerConfig({
        ...TESTNET_BASE,
        CAPITALDESK_READ_CREDENTIAL_REF: 'file:///run/secrets/read',
      });
      expect(config.readCredentialRef).toBe('file:///run/secrets/read');
    });
  });

  it('reports every configuration problem at once rather than one at a time', () => {
    try {
      loadApiConfig({ ...API_BASE, CAPITALDESK_ENV: 'nope', CAPITALDESK_API_PORT: '0' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as ConfigurationError).issues.length).toBeGreaterThan(1);
    }
  });
});
