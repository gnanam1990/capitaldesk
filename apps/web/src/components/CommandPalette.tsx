'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';

const COMMANDS = [
  { label: 'Overview', detail: 'Readiness and owner attention', href: '/' },
  { label: 'Intent queue', detail: 'Targets, revisions and conflicts', href: '/intents' },
  { label: 'Capital ledger', detail: 'Exact per-asset claims', href: '/capital' },
  { label: 'Plan review', detail: 'Immutable payload and FIFO', href: '/plans' },
  { label: 'Orders & recovery', detail: 'Known, held and missing evidence', href: '/orders' },
  { label: 'Evidence', detail: 'Ledger journal and manifests', href: '/evidence' },
  { label: 'State gallery', detail: 'Labelled interface fixtures', href: '/ui-states' },
] as const;

export function CommandPalette() {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        dialog.current?.showModal();
        requestAnimationFrame(() => input.current?.focus());
      }
    };
    window.addEventListener('keydown', open);
    return () => window.removeEventListener('keydown', open);
  }, []);

  const shown = COMMANDS.filter((command) =>
    `${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <button
        className="cd-command-trigger"
        type="button"
        onClick={() => dialog.current?.showModal()}
        aria-label="Open command palette"
      >
        <Icon name="search" width="17" height="17" />
        <span>Find anything</span>
        <kbd>⌘ K</kbd>
      </button>
      <dialog className="cd-command" ref={dialog} onClose={() => setQuery('')}>
        <div className="cd-command-head">
          <Icon name="search" width="19" height="19" />
          <label className="cd-sr-only" htmlFor="command-search">
            Search CapitalDesk destinations
          </label>
          <input
            id="command-search"
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search pages and actions"
          />
          <button type="button" onClick={() => dialog.current?.close()}>
            Esc
          </button>
        </div>
        <nav aria-label="Command results" className="cd-command-results">
          {shown.length === 0 ? <p>No matching destination.</p> : null}
          {shown.map((command) => (
            <Link key={command.href} href={command.href} onClick={() => dialog.current?.close()}>
              <span>{command.label}</span>
              <small>{command.detail}</small>
              <Icon name="arrow" width="17" height="17" />
            </Link>
          ))}
        </nav>
      </dialog>
    </>
  );
}
