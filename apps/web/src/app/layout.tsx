import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/manrope';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './globals.css';
import { loadWebPublicConfig } from '@capitaldesk/config';
import { AppShell } from '../components/AppShell';
import { previewMode } from '../lib/preview-data';

export const metadata: Metadata = {
  title: 'CapitalDesk',
  description: 'Owner-approved shared-account execution coordinator.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const config = loadWebPublicConfig();
  return (
    <html lang="en">
      <body>
        <a className="cd-skip-link" href="#main">
          Skip to main content
        </a>
        <AppShell
          accountAlias={config.accountAlias}
          environment={config.deploymentEnvironment}
          epoch={config.baselineEpoch}
          demo={previewMode(process.env)}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
