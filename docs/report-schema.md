# JSON report and exit codes

Run `soroban-guard <contract-id> --format json > report.json` to save the
report. A completed run writes one JSON object to stdout, including when
the exit code is 1 or 2. Progress goes to stderr. Argument and
configuration errors can exit 2 before a report is available. Integrations
should record the process exit code and check that stdout contains a
report before parsing it.

## Report fields

| Field | Type and meaning |
| --- | --- |
| `schema` | String. The schema in this document is `soroban-guard/report@1`. |
| `toolVersion` | Optional string. The version of soroban-guard that ran the checks. |
| `standard` | String. The standard selected for the run, currently `SEP-41`. |
| `contractId` | String. The Stellar contract address under test. |
| `rpcUrl` | String. The RPC endpoint with credentials, paths, and queries redacted when present. |
| `ranAt` | String. ISO 8601 timestamp for the run. |
| `exitCode` | Number. The exit code for these results. |
| `summary` | Object with integer counts in `total`, `pass`, `fail`, `unverifiable`, `skipped`, and `notImplemented`. |
| `results` | Array of check results. |

Each result provides the string fields `id`, `clause`, `layer`,
`requirement`, `status`, `expected`, and `actual`, an `evidence` object,
and a numeric `durationMs`. Identify checks by `id`. The prose in
`clause`, `expected`, `actual`, and `evidence.error` is for people to read
and may change between releases.

`layer` is `interface`, `behavior`, or `events`. The 0.5.1 suite has
interface and behavior checks. `requirement` is `required` or `optional`.

Evidence fields depend on what the check observed. `before` and `after`
hold balances or allowances as decimal strings keyed by label. Keep
these values as strings or parse them with arbitrary-precision integers.
`txHash` identifies a transaction the checker tried to submit, including a
write whose outcome is still unknown. `ledger` identifies the ledger of
an observation or settled write. Some checks report additional fields, such as
`confirmTxHash` for the second approval. A single run can span multiple
ledgers.

## Check status and exit code

| Status | Meaning |
| --- | --- |
| `PASS` | The check observed the expected result. |
| `FAIL` | The check established a violation. |
| `UNVERIFIABLE` | Available evidence or prerequisites could not establish a verdict. |
| `SKIPPED` | The check did not complete an assessment. |
| `NOT_IMPLEMENTED` | The contract does not expose the member. |

| Exit code | Meaning for automation |
| --- | --- |
| `0` | The run has results, every applicable check passed, and any absent members are optional. |
| `1` | At least one check failed or a required member is missing. This takes precedence over an inconclusive result elsewhere in the run. |
| `2` | A check was skipped or unverifiable, the run has no results, or the CLI rejected the invocation. |

Treat exit code 2 as incomplete evidence. A read-only run may exit 2
because it could not exercise writes.

## Compatibility

Check `schema` before consuming a report. The types and meaning of the
documented fields and the exit-code rules are stable within `report@1`.
New optional fields may appear. Consumers should accept them and should
read the actual rows instead of assuming a fixed number or order of
checks. Changing a documented field incompatibly or changing the
meaning of a status or exit code requires a new report schema version.
Check coverage and verdict accuracy can improve with a new tool
release. Use `toolVersion` when comparing runs.

See the [committed Testnet reports](../packages/web/src/data/results/)
for examples and the [check reference](check-reference.md) for how the
SEP-41 checks reach their verdicts.
