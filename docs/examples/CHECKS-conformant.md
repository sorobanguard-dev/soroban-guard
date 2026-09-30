# SEP-41 Conformance Report

| | |
| --- | --- |
| Contract | `CCTZKRT5WCOLI4JLA7FXWL4PN6TGH5XRHD4FI747DPSGL3FTUS5VF5PM` |
| Network | `https://soroban-testnet.stellar.org` |
| Run at | 2026-09-30T15:17:18.084Z |
| Checks | 16 |

**Conformant — all 16 checks were exercised and held. Exit code 0.**

## Verdicts

- `PASS` — the clause was exercised and held
- `FAIL` — the clause was exercised and was violated
- `UNVERIFIABLE` — the clause could not be exercised; no verdict either way
- `SKIPPED` — the check could not run (harness or network failure)
- `NOT_IMPLEMENTED` — the contract does not declare this member

## Layer: interface (3/3 pass)

| Check | Clause | Requirement | Status | Observed |
| --- | --- | --- | --- | --- |
| `sep41-decimals` | SEP-41 §decimals | required | PASS | returned 7 |
| `sep41-name` | SEP-41 §name | required | PASS | name is "GUARD:GD3XQT4IBZ7TW5WAZKXGK3NRPWXPCAYDZYW32S5WV6HSOHXHM6WKKPC2" |
| `sep41-symbol` | SEP-41 §symbol | required | PASS | symbol is "GUARD" |

### `sep41-decimals`

- expected: u32 decimal precision
- observed: returned 7
- ledger: 4951570

### `sep41-name`

- expected: string token name
- observed: name is "GUARD:GD3XQT4IBZ7TW5WAZKXGK3NRPWXPCAYDZYW32S5WV6HSOHXHM6WKKPC2"
- ledger: 4951570

### `sep41-symbol`

- expected: string token symbol
- observed: symbol is "GUARD"
- ledger: 4951570

## Layer: behavior (13/13 pass)

| Check | Clause | Requirement | Status | Observed |
| --- | --- | --- | --- | --- |
| `sep41-balance` | SEP-41 §balance | required | PASS | balance is 10000000000 |
| `sep41-allowance` | SEP-41 §allowance | required | PASS | allowance is 0 |
| `sep41-transfer_from-unauthorized` | SEP-41 §transfer_from | required | PASS | an unauthorized spend was refused |
| `sep41-transfer-zero-amount` | SEP-41 §transfer | required | PASS | the call was accepted and both balances held, at 10000000000 and 0 |
| `sep41-transfer-self` | SEP-41 §transfer | required | PASS | the call was accepted and the balance held at 10000000000 |
| `sep41-transfer-negative-amount` | SEP-41 §transfer | required | PASS | a transfer of -1 was refused |
| `sep41-transfer-over-balance` | SEP-41 §transfer | required | PASS | a transfer of 10000000001 against a balance of 10000000000 was refused |
| `sep41-transfer` | SEP-41 §transfer | required | PASS | holder -1, recipient +1 |
| `sep41-approve` | SEP-41 §approve | required | PASS | allowance is 2 after approving 2 over 1 |
| `sep41-transfer_from` | SEP-41 §transfer_from | required | PASS | holder -1, recipient +1, allowance -1 |
| `sep41-burn` | SEP-41 §burn | required | PASS | holder -1 |
| `sep41-burn_from` | SEP-41 §burn_from | required | PASS | holder -1, spender 0, allowance -1 |
| `sep41-transfer_from-expired` | SEP-41 §transfer_from | required | PASS | a spend against an allowance that expired at ledger 4951585 was refused at ledger 4951586 |

### `sep41-balance`

- expected: non-negative balance for the holder
- observed: balance is 10000000000
- ledger: 4951570

### `sep41-allowance`

- expected: non-negative allowance from owner to spender
- observed: allowance is 0
- ledger: 4951570

### `sep41-transfer_from-unauthorized`

- expected: transfer_from refuses a spender with no allowance from the holder
- observed: an unauthorized spend was refused
- error: `Transaction simulation failed: "HostError: Error(Contract, #9)  Event log (newest first):    0: [Diagnostic Event] contract:CCTZKRT5WCOLI4JLA7FXWL4PN6TGH5XRHD4FI747DPSGL3FTUS5VF5PM, topics:[error, Error(Contract, #9)], data:["not enough allowance to spend", 0, 1]    1: [Diagnostic Event] topics:[fn_call, CCTZKRT5WCOLI4JLA7FXWL4PN6TGH5XRHD4FI747DPSGL3FTUS5VF5PM, transfer_from], data:[GATHCREGWUL7SDL7WFUOMERYNRXVEBBOO5BSFKVARIQT2BQSZAS3T7O4, GDUIQISQLDIB63YLIESHDJIPBJQNYPTNGK5LAWKBBZXAFAWJH5SCUAQ3, GATHCREGWUL7SDL7WFUOMERYNRXVEBBOO5BSFKVARIQT2BQSZAS3T7O4, 1] "`

### `sep41-transfer-zero-amount`

- expected: a transfer of zero leaves both balances unchanged
- observed: the call was accepted and both balances held, at 10000000000 and 0
- before: `{"holder":"10000000000","recipient":"0"}`
- after: `{"holder":"10000000000","recipient":"0"}`
- tx: `d3fca07b917d90284f20adb33c9d36ff3c19b23e3e1cd34a8a4141f2a361034f`
- ledger: 4951572

### `sep41-transfer-self`

- expected: a transfer to oneself leaves the balance unchanged
- observed: the call was accepted and the balance held at 10000000000
- before: `{"holder":"10000000000"}`
- after: `{"holder":"10000000000"}`
- tx: `db3a84f36f82da9090eb74d7edc9f27135a056ef516845cf30acacb411d66fd0`
- ledger: 4951573

### `sep41-transfer-negative-amount`

- expected: transfer refuses a negative amount
- observed: a transfer of -1 was refused
- before: `{"holder":"10000000000","recipient":"0"}`
- error: `Transaction simulation failed: "HostError: Error(Contract, #8)  Event log (newest first):    0: [Diagnostic Event] contract:CCTZKRT5WCOLI4JLA7FXWL4PN6TGH5XRHD4FI747DPSGL3FTUS5VF5PM, topics:[error, Error(Contract, #8)], data:["negative amount is not allowed", -1]    1: [Diagnostic Event] topics:[fn_call, CCTZKRT5WCOLI4JLA7FXWL4PN6TGH5XRHD4FI747DPSGL3FTUS5VF5PM, transfer], data:[GDUIQISQLDIB63YLIESHDJIPBJQNYPTNGK5LAWKBBZXAFAWJH5SCUAQ3, GATHCREGWUL7SDL7WFUOMERYNRXVEBBOO5BSFKVARIQT2BQSZAS3T7O4, -1] "`

### `sep41-transfer-over-balance`

- expected: transfer refuses to move more than the holder's balance
- observed: a transfer of 10000000001 against a balance of 10000000000 was refused
- before: `{"holder":"10000000000","recipient":"0"}`
- error: `Transaction simulation failed: "HostError: Error(Contract, #10)  Event log (newest first):    0: [Diagnostic Event] contract:CCTZKRT5WCOLI4JLA7FXWL4PN6TGH5XRHD4FI747DPSGL3FTUS5VF5PM, topics:[error, Error(Contract, #10)], data:["resulting balance is not within the allowed range", 0, -1, 9223372036854775807]    1: [Diagnostic Event] topics:[fn_call, CCTZKRT5WCOLI4JLA7FXWL4PN6TGH5XRHD4FI747DPSGL3FTUS5VF5PM, transfer], data:[GDUIQISQLDIB63YLIESHDJIPBJQNYPTNGK5LAWKBBZXAFAWJH5SCUAQ3, GATHCREGWUL7SDL7WFUOMERYNRXVEBBOO5BSFKVARIQT2BQSZAS3T7O4, 10000000001] "`

### `sep41-transfer`

- expected: transfer moves the amount from holder to recipient
- observed: holder -1, recipient +1
- before: `{"holder":"10000000000","recipient":"0"}`
- after: `{"holder":"9999999999","recipient":"1"}`
- tx: `7337048e69bf7e91285420f6b5e666d1235d43cf029462ff18ed9613f25799eb`
- ledger: 4951575

### `sep41-approve`

- expected: approve sets the spender's allowance to the given amount
- observed: allowance is 2 after approving 2 over 1
- before: `{"allowance":"0"}`
- after: `{"allowance":"2"}`
- tx: `ff1f2ac1ed06113342f813232a85ce367b32435ce05d20cc4bde2bb690f377e1`
- ledger: 4951577

### `sep41-transfer_from`

- expected: transfer_from moves the amount and consumes the spender's allowance
- observed: holder -1, recipient +1, allowance -1
- before: `{"holder":"9999999999","recipient":"1","allowance":"2"}`
- after: `{"holder":"9999999998","recipient":"2","allowance":"1"}`
- tx: `ae123ca161c319ca37c9d39fe7e7580ef9ae6bcf12109238a66e68ec5f3f7bdc`
- ledger: 4951580

### `sep41-burn`

- expected: burn removes the amount from the holder's balance
- observed: holder -1
- before: `{"holder":"9999999998"}`
- after: `{"holder":"9999999997"}`
- tx: `85ce14091aa4633a9f2bb794cda184e139b515bd2fa9e162602e60d70b6a0aaf`
- ledger: 4951582

### `sep41-burn_from`

- expected: burn_from removes the amount from the holder and consumes the allowance
- observed: holder -1, spender 0, allowance -1
- before: `{"holder":"9999999997","spender":"2","allowance":"1"}`
- after: `{"holder":"9999999996","spender":"2","allowance":"0"}`
- tx: `7e5ff04101f517e94f9c6993cdbf4ef7c206cc692106d2317f9653b9cdb6f399`
- ledger: 4951583

### `sep41-transfer_from-expired`

- expected: transfer_from refuses a spend against an allowance whose live_until_ledger has passed
- observed: a spend against an allowance that expired at ledger 4951585 was refused at ledger 4951586
- before: `{"allowance":"0","holder":"9999999996","recipient":"2"}`
- ledger: 4951586
- error: `Transaction simulation failed: "HostError: Error(Contract, #9)  Event log (newest first):    0: [Diagnostic Event] contract:CCTZKRT5WCOLI4JLA7FXWL4PN6TGH5XRHD4FI747DPSGL3FTUS5VF5PM, topics:[error, Error(Contract, #9)], data:["not enough allowance to spend", 0, 1]    1: [Diagnostic Event] topics:[fn_call, CCTZKRT5WCOLI4JLA7FXWL4PN6TGH5XRHD4FI747DPSGL3FTUS5VF5PM, transfer_from], data:[GATHCREGWUL7SDL7WFUOMERYNRXVEBBOO5BSFKVARIQT2BQSZAS3T7O4, GDUIQISQLDIB63YLIESHDJIPBJQNYPTNGK5LAWKBBZXAFAWJH5SCUAQ3, GATHCREGWUL7SDL7WFUOMERYNRXVEBBOO5BSFKVARIQT2BQSZAS3T7O4, 1] "`

---

Generated by [soroban-guard](https://github.com/sorobanguard-dev/soroban-guard).
Each verdict describes the contract as it stood during this run. Writes move balances and allowances, so a later run against the same contract is a fresh check, not a replay of this one.

