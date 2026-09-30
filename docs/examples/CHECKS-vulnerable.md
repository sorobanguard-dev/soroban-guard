# SEP-41 Conformance Report

| | |
| --- | --- |
| Contract | `CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54` |
| Network | `https://soroban-testnet.stellar.org` |
| Run at | 2026-09-30T20:21:58.864Z |
| Checks | 16 |

**Violation found — 2 violated of 16 checks. Exit code 1.**

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
| `sep41-name` | SEP-41 §name | required | PASS | name is "Vulnerable Demo Token" |
| `sep41-symbol` | SEP-41 §symbol | required | PASS | symbol is "VULN" |

### `sep41-decimals`

- expected: u32 decimal precision
- observed: returned 7
- ledger: 4955226

### `sep41-name`

- expected: string token name
- observed: name is "Vulnerable Demo Token"
- ledger: 4955226

### `sep41-symbol`

- expected: string token symbol
- observed: symbol is "VULN"
- ledger: 4955226

## Layer: behavior (6/13 pass)

| Check | Clause | Requirement | Status | Observed |
| --- | --- | --- | --- | --- |
| `sep41-balance` | SEP-41 §balance | required | PASS | balance is 5 |
| `sep41-allowance` | SEP-41 §allowance | required | PASS | allowance is 0 |
| `sep41-transfer_from-unauthorized` | SEP-41 §transfer_from | required | PASS | an unauthorized spend was refused |
| `sep41-transfer-zero-amount` | SEP-41 §transfer | required | PASS | the call was accepted and both balances held, at 5 and 0 |
| `sep41-transfer-self` | SEP-41 §transfer | required | **FAIL** | the holder's balance moved from 5 to 6; debiting and crediting the same address must net zero, so a change means one side was applied without the other |
| `sep41-transfer-negative-amount` | SEP-41 §transfer | required | **FAIL** | a transfer of -1 succeeded; the holder gained, consistent with the contract reading it as a transfer in the opposite direction — anyone can withdraw from anyone |
| `sep41-transfer-over-balance` | SEP-41 §transfer | required | UNVERIFIABLE | recipient balance unreadable (balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted); cannot establish that neither party is the asset issuer |
| `sep41-transfer` | SEP-41 §transfer | required | UNVERIFIABLE | balances unreadable; cannot establish a before state to compare against |
| `sep41-approve` | SEP-41 §approve | required | PASS | allowance is 2 after approving 2 over 1 |
| `sep41-transfer_from` | SEP-41 §transfer_from | required | UNVERIFIABLE | balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted; cannot establish a before state to compare against |
| `sep41-burn` | SEP-41 §burn | required | PASS | holder -1 |
| `sep41-burn_from` | SEP-41 §burn_from | required | UNVERIFIABLE | spender balance unreadable; cannot establish that the burn leaves it untouched |
| `sep41-transfer_from-expired` | SEP-41 §transfer_from | required | UNVERIFIABLE | recipient balance unreadable (balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted); cannot establish that neither party is the asset issuer |

### `sep41-balance`

- expected: non-negative balance for the holder
- observed: balance is 5
- ledger: 4955226

### `sep41-allowance`

- expected: non-negative allowance from owner to spender
- observed: allowance is 0
- ledger: 4955226

### `sep41-transfer_from-unauthorized`

- expected: transfer_from refuses a spender with no allowance from the holder
- observed: an unauthorized spend was refused
- error: `Transaction simulation failed: "HostError: Error(Contract, #2)  Event log (newest first):    0: [Diagnostic Event] contract:CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54, topics:[error, Error(Contract, #2)], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"    1: [Diagnostic Event] topics:[fn_call, CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54, transfer_from], data:[GARI7R26ACUZYA6PSAOWUASL5OG6W6F5WVJ4PVQIBWIHAFFGXBOMEIUK, GBDIMO7W6KWXTKHEMKGLRNAYT5QNZ2QM2UMIXPNSG2QDFUTOEHGJWPU4, GARI7R26ACUZYA6PSAOWUASL5OG6W6F5WVJ4PVQIBWIHAFFGXBOMEIUK, 1] "`

### `sep41-transfer-zero-amount`

- expected: a transfer of zero leaves both balances unchanged
- observed: the call was accepted and both balances held, at 5 and 0
- before: `{"holder":"5","recipient":"0"}`
- after: `{"holder":"5","recipient":"0"}`
- tx: `21c432328bd0b2600479793ceb64f38e61d4d8cb7d333dafeccc91b99c7cd5e6`
- ledger: 4955228

### `sep41-transfer-self`

- expected: a transfer to oneself leaves the balance unchanged
- observed: the holder's balance moved from 5 to 6; debiting and crediting the same address must net zero, so a change means one side was applied without the other
- before: `{"holder":"5"}`
- after: `{"holder":"6"}`
- tx: `8d2f078f25b052c94da826f009d08e64da4c8c95a79758fe870eef804e80364b`
- ledger: 4955229

### `sep41-transfer-negative-amount`

- expected: transfer refuses a negative amount
- observed: a transfer of -1 succeeded; the holder gained, consistent with the contract reading it as a transfer in the opposite direction — anyone can withdraw from anyone
- before: `{"holder":"6","recipient":"0"}`
- after: `{"holder":"7","recipient":"unreadable (balance() returned -1, which is negative)"}`
- tx: `1b5ddf1971346d80dc3ca0cccef864fa8c28bcd347e751e30c7617972bbc7e89`
- ledger: 4955230

### `sep41-transfer-over-balance`

- expected: transfer refuses to move more than the holder's balance
- observed: recipient balance unreadable (balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted); cannot establish that neither party is the asset issuer

### `sep41-transfer`

- expected: transfer moves the amount from holder to recipient
- observed: balances unreadable; cannot establish a before state to compare against

### `sep41-approve`

- expected: approve sets the spender's allowance to the given amount
- observed: allowance is 2 after approving 2 over 1
- before: `{"allowance":"0"}`
- after: `{"allowance":"2"}`
- tx: `baedc3735571eb2d138670ee10876fa858dbcf0704505ecb9ba451277fa4fdb6`
- ledger: 4955231

### `sep41-transfer_from`

- expected: transfer_from moves the amount and consumes the spender's allowance
- observed: balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted; cannot establish a before state to compare against

### `sep41-burn`

- expected: burn removes the amount from the holder's balance
- observed: holder -1
- before: `{"holder":"7"}`
- after: `{"holder":"6"}`
- tx: `35fb4c5a4168c716f0dd3109d35d993289e37fce8ffa6a0744136339cf05035d`
- ledger: 4955233

### `sep41-burn_from`

- expected: burn_from removes the amount from the holder and consumes the allowance
- observed: spender balance unreadable; cannot establish that the burn leaves it untouched

### `sep41-transfer_from-expired`

- expected: transfer_from refuses a spend against an allowance whose live_until_ledger has passed
- observed: recipient balance unreadable (balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted); cannot establish that neither party is the asset issuer

---

Generated by [soroban-guard](https://github.com/sorobanguard-dev/soroban-guard).
Each verdict describes the contract as it stood during this run. Writes move balances and allowances, so a later run against the same contract is a fresh check, not a replay of this one.

