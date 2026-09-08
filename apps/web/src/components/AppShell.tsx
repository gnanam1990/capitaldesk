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
}: {
  children: ReactNode;
  accountAlias: string;
  environment: string;
  epoch: number;
}) {
  const path = usePathname();
  return (
    <div className="cd-shell">
      <aside className="cd-nav">
        <Link className="cd-brand" href="/" aria-label="CapitalDesk overview">
          <Mark size={27} />
          <span>CapitalDesk</span>
        </Link>
        <div className="cd-desk-label">Owner operations</div>
        <nav aria-label="Primary">
          <ul className="cd-nav-list">
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
                    {item.href === '/plans' ? <span className="cd-nav-count">1</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="cd-nav-foot">
          <span className="cd-kicker">Account context</span>
          <strong className="cd-mono">{accountAlias}</strong>
          <span>
            {environment.toUpperCase()} · EPOCH {epoch}
          </span>
        </div>
      </aside>
      <div className="cd-workspace">
        <header className="cd-topbar">
          <div className="cd-account-facts" aria-label="Current account context">
            <span className="cd-mode">{environment.toUpperCase()}</span>
            <span className="cd-mono">{accountAlias}</span>
            <span>Baseline epoch {epoch}</span>
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
