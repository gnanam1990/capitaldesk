# Restore without replaying old authority

A restored copy is a reconciliation source, not an active executor. Its first durable state
must be `HALTED_RECONCILING`; do not start the executor or publish old outbox messages.

## Before restore

1. Stop the API, worker and executor that would use the target database.
2. Record the incident or recovery ticket, archive path, manifest path and intended target.
3. Confirm the target database is newly created and isolated from all application principals.
4. Locate the external authorization evidence bundle for the same backup epoch. If both the
   database authorization row and its external bundle are unavailable, record
   `RESTORE_ATTRIBUTION_UNRECOVERABLE`; do not infer a FIFO allocation.

## Restore

Set the explicit acknowledgement and a concrete reason, then run the guarded script:

```sh
export RESTORE_DATABASE_URL=<empty-target-database-url>
export CAPITALDESK_RESTORE_ACK=HALT_AND_RECONCILE
export CAPITALDESK_RESTORE_REASON='incident-123 backup from 2026-09-08T12:00:00Z'
deploy/scripts/restore.sh <archive.dump> <archive.dump.manifest.json>
```

The script refuses a checksum mismatch, a malformed manifest and a non-empty target. After
`pg_restore`, it runs `db:restore-posture` before returning success.

## Reconcile before service

1. Verify every pool is `HALTED` and every old unpublished outbox item is quarantined.
2. Enumerate `DISPATCH_MARKED`, `SEND_ATTEMPTED`, `UNKNOWN` and
   `IRRECOVERABLE_UNCERTAINTY` attempts. These remain liabilities.
3. Query the venue by stable client order id using read-only credentials. Never resubmit an
   attempt because an HTTP response is missing.
4. Recover attribution only from a matching database authorization record or a valid external
   evidence bundle. Otherwise keep the plan in manual review with
   `RESTORE_ATTRIBUTION_UNRECOVERABLE`.
5. Rebuild current account cuts and reconcile external drift. Keep source uncertainty visible.
6. Let the owner create or explicitly resume authority under the current epoch. A successful
   restore does not resume a strategy, plan or executor.

Attach the restore output, database posture counts, liability list, reconciliation evidence and
the operator who approved any later resume to the incident record.
