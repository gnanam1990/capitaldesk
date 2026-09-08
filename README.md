# CapitalDesk

Owner-approved shared-account execution coordination with attributable strategy claims and
recoverable order evidence, for a single Binance Spot account.

**[Try the interactive demo](https://capitaldeskweb-production.up.railway.app/demo)**
— resolve competing targets, review a fixed FIFO plan, simulate a partial fill, and recover
from a missing response. All displayed account records are synthetic. No Binance account is
connected and the demo cannot place orders.

To run the demo locally, install dependencies, then run
`CAPITALDESK_UI_PREVIEW=true pnpm --filter @capitaldesk/web dev` and open
`http://localhost:3100/demo`. No database or account credential is needed for the demo.

Several strategy agents propose absolute target holdings. CapitalDesk checks ownership
claims, reserves capital, exposes conflicting proposals rather than resolving them silently,
obtains the owner's explicit approval for one exact plan, and reconciles actual exchange
execution into a per-strategy ledger.

> **Status: active implementation; release gate not passed.** Local contracts, PostgreSQL
> journal paths, planning and reconciliation components exist, but no version-bound clean-room
> testnet release manifest has passed. No authenticated Binance account has been contacted in
> the recorded evidence. See [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) for implementation
> status and [docs/release-readiness.md](docs/release-readiness.md) for the release decision.

## What it does not do

Stated first, because the boundaries are the product:

- It does not promise better returns, and measures none.
- It does not cross opposing strategy intents, net them, or record imaginary fills.
- It does not support leverage, derivatives, short inventory, customer pooling, transfers or
  withdrawals.
- It does not resubmit an order whose outcome is uncertain. Ambiguity keeps capital reserved.
- It cannot detect every external movement. A net balance change across a reconciliation
  window is detected; a set of movements that offsets to zero on a symbol outside the
  observed set is not, because the venue offers no account-wide enumeration of completed
  trades. Such a window blocks execution rather than passing quietly.

## Prerequisites

- Node 22.20+ (`.nvmrc` pins 22.23.1)
- pnpm 11 (`packageManager` pins 11.10.0)
- PostgreSQL 17 for the integration suite

## Setup

```sh
pnpm install --frozen-lockfile
cp .env.example .env          # placeholders only; never commit a real value
createdb capitaldesk
pnpm run db:migrate
```

## Verification

```sh
pnpm run verify               # format, typecheck, lint, boundaries, unit, property, build
```

The integration suite needs a real database and is deliberately separate, so a green unit
run can never be mistaken for database coverage:

```sh
createdb capitaldesk_test
CAPITALDESK_TEST_DATABASE_URL=postgres://localhost:5432/capitaldesk_test pnpm run test:integration
```

Without that variable the gate **refuses to run** and exits non-zero. It used to let vitest
skip every database suite and exit 0, which reported a passing integration gate with 226 of
241 tests skipped and no PostgreSQL anywhere. The preflight now stands in front of it and
names the variable to set; it never prints the value.

To run only the process-level suites, which need no database, use the explicitly named
non-gate command:

```sh
pnpm run test:process-only
```

That command is not the integration gate and must not be quoted as integration evidence. CI
runs the gate with a real PostgreSQL service and additionally fails if anything skips.

Release proof is a separate, stricter gate. It verifies a clean exact commit, dependency
lockfile, test plan, migration set and every evidence-file digest, then requires the proof
class appropriate to each scenario:

```sh
mkdir -p artifacts/local/proof
pnpm proof:create -- --descriptor docs/evidence/proof-descriptor.example.json \
  --out artifacts/local/proof/manifest.json
pnpm proof:verify -- --bundle artifacts/local/proof
pnpm release:gate -- --bundle artifacts/local/proof
```

The example descriptor is intentionally local and incomplete, so its release gate fails. A
passing manifest must come from the documented clean testnet run; renaming fixture output to
`venue` is rejected.

## Running

```sh
pnpm --filter @capitaldesk/api  run start   # health endpoints on 127.0.0.1:3000
pnpm --filter @capitaldesk/web  run dev     # console on 127.0.0.1:3100
```

`GET /health/ready` reports process liveness, dependency readiness and execution availability
as three separate facts. Execution is currently reported unavailable with a structural
reason, because no execution path is implemented. Connected is not the same as safe to
execute, and the endpoint says so.

## Configuration

All configuration is validated and fails closed. There is no default host, no inferred
environment and no capability that is enabled unless disabled.

Secrets are **references** — a file path or secret-manager URI — never values, and each class
mounts into exactly one process role: `VENUE_READ` into the worker, `VENUE_TRADE` into the
executor, `OWNER_SESSION` into the API, none into the console. A credential variable present
in the wrong role refuses startup by name. See
[ADR-0007](docs/adr/0007-credential-classes.md).

Venue hosts are allowlisted per environment, and a non-production deployment pointed at the
live host is refused explicitly.

## Repository layout

```
apps/api        owner and agent HTTP API; never holds a venue trading secret
apps/worker     ingest and reconciliation; holds the read credential reference only
apps/executor   the only component permitted to hold the trade credential
apps/web        owner console; reaches data through the API only
packages/contracts      money, identities, states, digests, capability gates
packages/config         validated fail-closed environment contracts
packages/observability  redacted structured logging
packages/db             migration lifecycle
tools/          dependency-layering and credential-boundary checkers
docs/adr/       decisions amending the reviewed specification
specs/capitaldesk/      the specification pack, as amended
```

Layering and the credential boundary are enforced by commands, not convention:

```sh
pnpm run check:layering
pnpm run check:secrets
```

## Documentation

| Document                                                               | Purpose                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md)                       | What is built, proven and blocked                       |
| [docs/requirements-traceability.md](docs/requirements-traceability.md) | Every requirement mapped to code, tests and proof class |
| [docs/architecture.md](docs/architecture.md)                           | Trust and economic data-flow boundaries                 |
| [docs/quickstart.md](docs/quickstart.md)                               | Clean local setup and explicit testnet stop point       |
| [docs/operator-guide.md](docs/operator-guide.md)                       | Normal operation, halt and recovery                     |
| [docs/release-readiness.md](docs/release-readiness.md)                 | Evidence-backed release decision                        |
| [docs/adr/](docs/adr/)                                                 | Decisions amending the reviewed specification           |
| [docs/handoffs/](docs/handoffs/)                                       | Per-milestone evidence records                          |
| [specs/capitaldesk/](specs/capitaldesk/)                               | The specification pack                                  |
| [specs/capitaldesk/AMENDMENTS.md](specs/capitaldesk/AMENDMENTS.md)     | What changed since review, and why                      |

## Licence

No licence is declared. This is a deliberate open decision for the repository owner, not an
oversight.
