# Integration capabilities

| Boundary                              | Implemented contract                                          | Recorded real proof                    | Release position            |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------------- | --------------------------- |
| Public Spot testnet time and metadata | allowlisted exact host, strict decoding                       | public reads recorded 8 September 2026 | available for metadata only |
| Authenticated account reads           | read-worker credential reference and typed failures           | none                                   | blocked                     |
| Broker-key testnet order write        | isolated trade credential and marked single send are required | none                                   | blocked                     |
| Agentic managed host                  | separate mode and native confirmation are required            | none                                   | disabled                    |
| Production Spot                       | explicit environment and current release approval required    | none                                   | disabled                    |

The upstream source revision and public observations are recorded in
`docs/evidence/binance-read-capability.md`. They do not prove access to an account or the
current fee schedule. A normal API key does not prove managed-host access.

`STANDARD_NO_BNB_V1` is the first intended real fee policy and remains subject to current
account-setting and cumulative-bound evidence. `QUOTE_FEE_FIXTURE_V1` is deterministic local
test data and cannot become external proof. An unexpected asset or excess fee is retained and
quarantined.

The account event stream cannot prove the complete movement universe after an unobservable
gap. An offsetting trade on an unknown symbol may leave matching balances. Such a window is
`UNSUPPORTED`, and the release tooling cannot convert it to COMPLETE.
