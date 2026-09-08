import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/manrope';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './globals.css';
import { Mark } from '../components/Mark';

export const metadata: Metadata = {
  title: 'CapitalDesk',
  description: 'Owner-approved shared-account execution coordinator.',
};

/**
 * The navigation the console will have (UI-UX section 3 / DESIGN-DIRECTION).
 *
 * Destinations whose backing routes and domain behaviour do not exist yet are rendered as
 * disabled with a stated reason rather than as links that go nowhere. A dead nav item is a
 * false claim about what the product does; a disabled one that names the module it is
 * waiting on is a truthful map of where the work is.
 */
const NAVIGATION: ReadonlyArray<{ label: string; href: string | null; blockedBy: string }> = [
  { label: 'Overview', href: '/', blockedBy: '' },
  { label: 'Intents', href: null, blockedBy: 'module 07 — strategy lifecycle and targets' },
  { label: 'Capital', href: null, blockedBy: 'module 06 — baseline and claim ledger' },
  { label: 'Plans', href: null, blockedBy: 'module 09 — deterministic planner' },
  { label: 'Orders & Recovery', href: null, blockedBy: 'module 15 — order reconciliation' },
  { label: 'Evidence', href: null, blockedBy: 'module 24 — evidence and exports' },
  { label: 'Settings', href: null, blockedBy: 'module 03 — identity and access' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="cd-skip-link" href="#main">
          Skip to main content
        </a>
        <div className="cd-shell">
          <nav aria-label="Primary" className="cd-nav">
            <div className="cd-brand">
              <Mark size={26} />
              <span>CapitalDesk</span>
            </div>

            <ul className="cd-nav-list">
              {NAVIGATION.map((item) => (
                <li key={item.label}>
                  {item.href === null ? (
                    <span
                      aria-disabled="true"
                      title={`Not available yet: ${item.blockedBy}`}
                      className="cd-nav-item cd-nav-item--blocked"
                    >
                      {item.label}
                      <span className="cd-nav-note">not built yet</span>
                    </span>
                  ) : (
                    <a
                      href={item.href}
                      aria-current="page"
                      className="cd-nav-item cd-nav-item--current"
                    >
                      {item.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </nav>

          <main id="main" className="cd-main">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
