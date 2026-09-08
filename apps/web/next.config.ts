import type { NextConfig } from 'next';

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
};

export default config;
