# CapitalDesk threat model

CapitalDesk coordinates authority over shared capital. Strategy agents, venue adapters,
browser clients, upstream APIs, imported CSV data and restored infrastructure are untrusted
inputs. The PostgreSQL journal, explicit owner approval and separated credential principals
form the core trust boundary.

## Threats and enforced boundaries

| Threat                                  | Required boundary                                                                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious or compromised strategy agent | Agents submit intents only. Pool mandates, reservations, sealing and owner approval bound executable authority.                                                                   |
| Forged, replayed or stale approval      | Approval binds the sealed plan hash, epoch, allocation version and expiry; restore never reconstructs missing authority by guess.                                                 |
| Duplicate send or lost HTTP response    | A durable dispatch marker and stable client order id precede one transport attempt. Missing response becomes an unknown liability and is not resent.                              |
| Credential disclosure                   | Configuration carries secret references. API, worker and executor receive different secrets and OS identities; raw secret environment names are rejected.                         |
| SSRF or production misrouting           | Deployment environment uses an exact venue-origin allowlist. Testnet proxy accepts only the testnet HTTPS origin and two order paths. Host-level egress policy is still required. |
| SQL injection                           | Queries use bound parameters; database roles should have only their required statements. Migration and restore tools run as separate operator actions.                            |
| HTML/script injection                   | Web output must render data as text, apply a restrictive CSP and avoid raw HTML sinks. API responses include no-sniff, frame and cache restrictions.                              |
| Spreadsheet formula injection           | Exports must prefix formula-leading cells and retain the original value in structured evidence. CSV is data, not an execution format.                                             |
| Oversized or abusive requests           | API body size is bounded and authentication failures use fixed-cardinality metrics. Rate limiting belongs at the trusted ingress.                                                 |
| Dependency or image compromise          | Builds use pinned package-manager and base-image versions. Release automation must add digest pinning, SBOM and vulnerability policy before production use.                       |
| Stale queues after restore              | Restore quarantines old unpublished outbox work, halts pools and retains marked liabilities for read-only reconciliation.                                                         |

## Evidence limits

The deterministic fault lab proves state-machine invariants for generated fixture inputs. A
PostgreSQL fixture proves database constraints and concurrent transactions. A real testnet run
proves only the captured testnet request and response for that build and epoch. None of these
are production venue evidence.

The deployment operator remains trusted to provision correct external secrets, enforce the
documented hostname egress policy, retain authorization bundles independently and protect the
database administration plane. Loss of both database authorization evidence and the matching
external bundle is a terminal attribution gap, reported as
`RESTORE_ATTRIBUTION_UNRECOVERABLE`.
