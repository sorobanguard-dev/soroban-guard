# SEP-41 Conformance Report

| | |
| --- | --- |
| Contract | `CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54` |
| Network | `https://soroban-testnet.stellar.org` |
| Run at | 2026-09-30T15:18:54.803Z |
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
- ledger: 4951589

### `sep41-name`

- expected: string token name
- observed: name is "Vulnerable Demo Token"
- ledger: 4951590

### `sep41-symbol`

- expected: string token symbol
- observed: symbol is "VULN"
- ledger: 4951590

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
- ledger: 4951590

### `sep41-allowance`

- expected: non-negative allowance from owner to spender
- observed: allowance is 0
- ledger: 4951590

### `sep41-transfer_from-unauthorized`

- expected: transfer_from refuses a spender with no allowance from the holder
- observed: an unauthorized spend was refused
- error: `Transaction simulation failed: "HostError: Error(Contract, #2)  Event log (newest first):    0: [Diagnostic Event] contract:CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54, topics:[error, Error(Contract, #2)], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"    1: [Diagnostic Event] topics:[fn_call, CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54, transfer_from], data:[GDMXSZOD6UCHWY63QVTMCOC3CZEN5QMU3ACKDO5JQYNBGZO3WZX65ALA, GB4AXMGJXIAO4MO4FISYVPDRJFXBUL6R7YOL7XMK4HTYGG24CVQXUWPX, GDMXSZOD6UCHWY63QVTMCOC3CZEN5QMU3ACKDO5JQYNBGZO3WZX65ALA, 1] "`

### `sep41-transfer-zero-amount`

- expected: a transfer of zero leaves both balances unchanged
- observed: the call was accepted and both balances held, at 5 and 0
- before: `{"holder":"5","recipient":"0"}`
- after: `{"holder":"5","recipient":"0"}`
- tx: `7b3a0f957ac422976e358516f236279a83966c8a6b41277b4884f40963757a42`
- ledger: 4951592

### `sep41-transfer-self`

- expected: a transfer to oneself leaves the balance unchanged
- observed: the holder's balance moved from 5 to 6; debiting and crediting the same address must net zero, so a change means one side was applied without the other
- before: `{"holder":"5"}`
- after: `{"holder":"6"}`
- tx: `ad307291ebd3c7aa6731a065751720b867de99014548c4454ca0a208c426e659`
- ledger: 4951594

### `sep41-transfer-negative-amount`

- expected: transfer refuses a negative amount
- observed: a transfer of -1 succeeded; the holder gained, consistent with the contract reading it as a transfer in the opposite direction — anyone can withdraw from anyone
- before: `{"holder":"6","recipient":"0"}`
- after: `{"holder":"7","recipient":"unreadable (balance() returned -1, which is negative)"}`
- tx: `7890155908bcbc06191673fa09fd876f73364676a6d1fe69f7c8f96f99b8eab5`
- ledger: 4951595

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
- tx: `d3365997bb2ae6630100cbf663a3082d13d9f7a8847120bab71b74d80795d7b3`
- ledger: 4951597

### `sep41-transfer_from`

- expected: transfer_from moves the amount and consumes the spender's allowance
- observed: balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted; cannot establish a before state to compare against

### `sep41-burn`

- expected: burn removes the amount from the holder's balance
- observed: holder -1
- before: `{"holder":"7"}`
- after: `{"holder":"6"}`
- tx: `7a894e144d1a9a7ca3d04b372cfa216e0ca2c2fe761d18786f59ae5a028873ba`
- ledger: 4951600

### `sep41-burn_from`

- expected: burn_from removes the amount from the holder and consumes the allowance
- observed: spender balance unreadable; cannot establish that the burn leaves it untouched

### `sep41-transfer_from-expired`

- expected: transfer_from refuses a spend against an allowance whose live_until_ledger has passed
- observed: recipient balance unreadable (balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted); cannot establish that neither party is the asset issuer

---

Generated by [soroban-guard](https://github.com/sorobanguard-dev/soroban-guard).
Each verdict describes the contract as it stood during this run. Writes move balances and allowances, so a later run against the same contract is a fresh check, not a replay of this one.

