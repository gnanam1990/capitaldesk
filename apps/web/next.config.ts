import type { NextConfig } from 'next';
import { apiRewrites } from './src/app/api-routing';

const config: NextConfig = {
  reactStrictMode: true,
  // The console renders nothing it did not fetch from the API. There is no remote image
  // host, no analytics and no third-party script: an operational console for a financial
  // account should not be sending its state anywhere.
  images: { remotePatterns: [] },
  poweredByHeader: false,
  // The repository already carries its own AGENTS.md; Next must not generate
  // competing ones inside apps/web.
  agentRules: false,
  // Same-origin /api routing, so the owner's SameSite=Strict session cookie is carried in
  // development exactly as it is in production. See src/app/api-routing.ts for why the
  // alternatives (a relaxed cookie, or credentialed CORS) are not acceptable.
  rewrites: () => Promise.resolve([...apiRewrites(requireApiBaseUrl())]),
};

/**
 * Read the API origin at config load, where a missing value stops the process, rather than
 * defaulting to a guess that would silently proxy the console somewhere it was not configured
 * for.
 */
function requireApiBaseUrl(): string {
  const value = process.env['NEXT_PUBLIC_CAPITALDESK_API_BASE_URL'];
  if (value === undefined || value === '') {
    throw new Error('NEXT_PUBLIC_CAPITALDESK_API_BASE_URL is required to route /api');
  }
  return value;
}

export default config;
