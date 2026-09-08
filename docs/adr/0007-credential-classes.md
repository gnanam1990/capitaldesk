# ADR-0007 — Three credential classes, bound to process roles

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F7 (Medium)
- Amends: TDD sections 2 and 3; prompts 01, 05, 12

## Context

Prompt 01 says secrets are mounted only into the executor. Prompt 05 needs an authenticated
account reader and says it has no trading key, without defining what it does have. Both cannot
be satisfied by one rule, and the ambiguity has security consequences: the natural shortcut is
to give the worker the executor's credential.

## Decision

### 1. Three classes with separate mounts

| Class           | Venue permission       | Mounted into          | Never into            |
| --------------- | ---------------------- | --------------------- | --------------------- |
| `VENUE_READ`    | USER_DATA (read)       | worker account reader | api, executor, web    |
| `VENUE_TRADE`   | TRADE                  | executor only         | api, worker, web      |
| `OWNER_SESSION` | none (session signing) | api only              | worker, executor, web |

`AGENT_PROPOSAL` credentials are hashed application credentials and are never venue secrets.

Binance documents separate TRADE and USER_DATA permissions, so this is an available pattern
rather than an aspiration. Whether the configured account actually supports the split is an
authenticated integration question and stays open until proven.

### 2. Secrets are references

Configuration carries a reference — a file path or secret-manager URI — never a secret value.
A trade credential variable present in the API or worker environment, a read credential in the
executor, or any venue credential in the browser configuration, is a startup refusal naming
the variable.

### 3. Reader and trader must be the same account

The read credential's authenticated stable account id must equal the trade credential's. A
mismatch blocks governance with `IDENTITY_UNSTABLE_ACCOUNT`: reconciling one account while
trading another is worse than not trading.

### 4. Enforcement

`tools/check-secret-boundary.ts` enforces the source-tree half statically, and
`tools/check-layering.ts` prevents the API, worker or console importing the executor by
package name _or_ by relative path. Both are static checks. They are not proof of process
isolation, which requires separate container users, mounts and service identities, and is
verified by the runtime boundary tests in module 12.

## Consequences

Three secret mounts to operate instead of one. The deployment documentation must state that
running everything under one unrestricted OS user is not a security boundary, as the TDD
already warns.

## Tests

Each forbidden variable refused per role; two distinct credentials for one stable account;
mismatched reader/trader identity blocking governance; a revoked reader; an attempted trade
using the reader identity. Extends T-036, T-037, T-038.
