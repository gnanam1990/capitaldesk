# Clean quickstart

## Local deterministic and database mode

Prerequisites are Node 22.20 or newer, pnpm 11.10 and PostgreSQL 17.

```sh
git clone <repository-url> capitaldesk
cd capitaldesk
corepack enable
pnpm install --frozen-lockfile
createdb capitaldesk_test
pnpm verify
CAPITALDESK_TEST_DATABASE_URL=postgresql:///capitaldesk_test pnpm test:integration
```

The integration command refuses to start without a reachable database. Process-only tests
are not database proof.

Copy `.env.example` to `.env` only for local process startup. Values remain secret-manager or
file references. Do not paste a credential value into the repository, process arguments,
proof bundle or screenshot.

## Testnet boundary

Stop before testnet until the owner has explicitly configured an authorized account,
confirmed the displayed `testnet` mode and account alias, and established a fresh baseline.
There is no production fallback. Run the normal product journey once, then the response-loss
journey, and collect the source order, fill and commission evidence from the read worker.

Create the proof manifest only from a clean checkout:

```sh
mkdir -p artifacts/local/proof
pnpm proof:create -- --descriptor <completed-descriptor.json> \
  --out artifacts/local/proof/manifest.json
pnpm proof:verify -- --bundle artifacts/local/proof
pnpm release:gate -- --bundle artifacts/local/proof
```

The manifest records the exact commit, lockfile, test-plan digest, migrations, mode, account
identity digest, epoch, fee policy and artifact hashes. Any later change makes it stale.
