'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Mark } from './Mark';
import { Icon, type IconName } from './Icons';
import { CommandPalette } from './CommandPalette';

const NAVIGATION: ReadonlyArray<{ label: string; href: string; icon: IconName }> = [
  { label: 'Overview', href: '/', icon: 'overview' },
  { label: 'Intents', href: '/intents', icon: 'intents' },
  { label: 'Capital', href: '/capital', icon: 'capital' },
  { label: 'Plans', href: '/plans', icon: 'plans' },
  { label: 'Orders', href: '/orders', icon: 'orders' },
  { label: 'Evidence', href: '/evidence', icon: 'evidence' },
  { label: 'Settings', href: '/settings', icon: 'settings' },
];

export function AppShell({
  children,
  accountAlias,
  environment,
  epoch,
  demo = false,
}: {
  children: ReactNode;
  accountAlias: string;
  environment: string;
  epoch: number;
  demo?: boolean;
}) {
  const path = usePathname();
  return (
    <div className="cd-shell">
      <aside className="cd-nav">
        <Link className="cd-brand" href="/" aria-label="CapitalDesk overview">
          <Mark size={27} />
          <span>CapitalDesk</span>
        </Link>
        <div className="cd-desk-label">{demo ? 'Shared-capital demo' : 'Owner operations'}</div>
        <nav aria-label="Primary">
          <ul className="cd-nav-list">
            {demo ? (
              <li>
                <Link
                  className="cd-nav-item"
                  href="/demo"
                  aria-current={path === '/demo' ? 'page' : undefined}
                >
                  <Icon name="plans" width="18" height="18" />
                  <span>Interactive demo</span>
                </Link>
              </li>
            ) : null}
            {NAVIGATION.map((item) => {
              const active =
                path === item.href || (item.href !== '/' && path.startsWith(item.href));
              return (
                <li key={item.href}>
                  <Link
                    className="cd-nav-item"
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon name={item.icon} width="18" height="18" />
                    <span>{item.label}</span>
                    {demo && item.href === '/plans' ? (
                      <span className="cd-nav-count">1</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="cd-nav-foot">
          <span className="cd-kicker">{demo ? 'Demo context' : 'Account context'}</span>
          <strong className="cd-mono">{demo ? 'CapitalDesk sample desk' : accountAlias}</strong>
          <span>
            {demo
              ? 'SAMPLE DATA · NO LIVE ORDERS'
              : `${environment.toUpperCase()} · EPOCH ${epoch}`}
          </span>
        </div>
      </aside>
      <div className="cd-workspace">
        <header className="cd-topbar">
          <div
            className="cd-account-facts"
            aria-label={demo ? 'Demo workspace context' : 'Current account context'}
          >
            <span className="cd-mode">{demo ? 'DEMO' : environment.toUpperCase()}</span>
            <span className="cd-mono">{demo ? 'BTC / USDT · SAMPLE DESK' : accountAlias}</span>
            <span>
              {demo ? 'Simulated account · no live connection' : `Baseline epoch ${epoch}`}
            </span>
          </div>
          <CommandPalette />
        </header>
        <main id="main" className="cd-main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
