# Deployment topology

CapitalDesk deploys as three application principals around one PostgreSQL authority. The API
accepts owner sessions, the worker observes the venue with read credentials, and the executor
is the only process allowed to receive a trade credential. The executor is absent from the
default Compose deployment and appears only when an operator explicitly selects the
`testnet-write` profile.

## Supported postures

| Config                     | Economic target               | Write capability                            | Authorization durability |
| -------------------------- | ----------------------------- | ------------------------------------------- | ------------------------ |
| `local-fixture.env`        | deterministic local fixture   | disabled                                    | single-node, at risk     |
| `testnet.env`              | Binance Spot testnet          | disabled until executor profile is selected | single-node, at risk     |
| `production-read-only.env` | Binance Spot production reads | disabled                                    | synchronous replica      |

These files do not contain credentials or database passwords. Docker secrets are separate by
principal: `owner_session` reaches only the API, `venue_read` reaches only the worker, and
`venue_trade` reaches only the executor. The executor uses a different numeric uid from the
API and worker, a read-only root filesystem, no Linux capabilities and a no-new-privileges
policy.

Compose networks enforce service separation, including an internal-only database network.
Compose alone cannot restrict DNS names on an egress network. A production deployment must
apply a host firewall, eBPF policy or CNI policy that permits the worker only to the declared
read origin and permits the executor only to `https://testnet.binance.vision`. The application
configuration performs a second exact-origin check and refuses a testnet process pointed at a
live venue. Network names are not evidence of a hostname allowlist.

## Starting a posture

Create the external Docker secrets before resolving the Compose model. The `database_url`
secret contains the full connection string and is read by the non-root launcher; it never
appears in the rendered Compose environment. Provide an immutable build id and inspect the
fully rendered model before starting it:

```sh
CAPITALDESK_BUILD_ID=<immutable-commit> \
docker compose --env-file deploy/config/testnet.env -f deploy/compose.yaml config
```

The default start launches PostgreSQL, API and read worker. Testnet execution additionally
requires the explicit profile:

```sh
docker compose --env-file deploy/config/testnet.env -f deploy/compose.yaml \
  --profile testnet-write up executor
```

Selecting a profile is only a process-start control. Dispatch still requires a valid sealed
plan, owner approval, live authorization evidence, a database marker and an application
configuration that accepts the selected environment. No repository test or static Compose
inspection proves venue connectivity.

## Backup and restore

`deploy/scripts/backup.sh` creates a PostgreSQL custom archive, a SHA-256 sidecar and a JSON
manifest. The manifest binds the immutable build, environment, migration-set digest and a
non-secret configuration fingerprint. It does not copy connection strings or credential
references.

`deploy/scripts/restore.sh` verifies the manifest checksum, refuses a target with any user
objects, restores in one transaction, then enters the database restore posture. That posture
halts every pool, quarantines unpublished outbox work, invalidates unmarked plans and retains
marked or unknown attempts as liabilities. See [Restore runbook](runbooks/restore.md) before
using it.
