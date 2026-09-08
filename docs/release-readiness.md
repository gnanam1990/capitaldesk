# Release readiness

**Decision: FAIL for testnet release; FAIL for production.** This is an evidence decision,
not a statement that local implementation work has no value.

| Gate                            | Result  | Evidence                                                                    |
| ------------------------------- | ------- | --------------------------------------------------------------------------- |
| deterministic build and tests   | PARTIAL | repository unit/property gates exist; rerun at final integrated head        |
| real PostgreSQL                 | PARTIAL | module suites have run on PostgreSQL 17.10; final all-suite manifest absent |
| process and credential boundary | PARTIAL | static boundary and process tests exist; final bypass bundle absent         |
| owner UI and accessibility      | PARTIAL | foundation observations exist; complete owner journey bundle absent         |
| authenticated testnet read      | FAIL    | no authorized credential or stable account identity evidence                |
| actual testnet IOC and fills    | FAIL    | no source order, fill or commission evidence                                |
| response-loss recovery at venue | FAIL    | no actual forwarded request/count and recovery bundle                       |
| final version-bound manifest    | FAIL    | no clean-room bundle covers every T-001–T-070 heading                       |
| production                      | FAIL    | out of initial testnet gate and never implicitly enabled                    |

The release gate is executable:

```sh
pnpm proof:verify -- --bundle artifacts/proofs/<build-id>
pnpm release:gate -- --bundle artifacts/proofs/<build-id>
```

It fails on a changed commit, dirty checkout, changed lockfile, test plan, migration set or
artifact bytes. It extracts the required scenario set from the authoritative test plan and
requires venue, browser, PostgreSQL, process and mutation evidence for the scenarios whose
boundary demands it. A local fixture cannot be declared venue evidence.

To change this decision, integrate every module, run the complete clean checkout and real
PostgreSQL suites, complete the normal and response-loss journeys on an explicitly authorized
Spot testnet account, capture independently checkable economic exports, and pass the manifest
gate at that same clean commit. Funded trading and public submission remain separate actions.
