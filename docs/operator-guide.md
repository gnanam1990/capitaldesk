# Operator guide

Before enabling a plan, confirm the stable account alias, environment, baseline epoch,
selected symbol, complete account cut, policy version and fee capability. Assign opening
HOUSE claims explicitly. An exchange balance is not a strategy budget.

Agents submit absolute target revisions. Review conflicts first. Compatible plans show the
strictest limit, requested gross quantity, worst-case debit, fee asset, FIFO schedule,
evidence ages and expiry. Approval binds that exact digest. A changed revision, policy,
inventory fact or expiry needs a new plan.

After dispatch, treat these states literally:

| State                                   | Operator action                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DISPATCH_MARKED` or `UNKNOWN`          | Halt dependent work and reconcile the exact client identity. Never place a replacement.                        |
| terminal venue status, incomplete pages | Keep reservations held and fetch the missing bounded page/cut.                                                 |
| reconciled partial fill                 | Inspect actual base, quote, commission and target residual. A residual creates no order.                       |
| evidence conflict or drift              | Keep the pool quarantined; acknowledge for workflow only. Supply source evidence or an append-only correction. |
| testnet reset                           | Fence senders, resolve outstanding attempts, retain the old epoch and establish a new baseline.                |

An owner or operator can halt. Only the owner can resume, after a fresh COMPLETE reconciliation
for the same account and no active incident or unresolved dispatch liability. Incident
acknowledgement does not alter balances or prove an order absent.

Exports and support bundles must preserve correlation IDs while redacting credentials,
signed URLs and sensitive headers. Use the manifest verifier before sharing a bundle.
