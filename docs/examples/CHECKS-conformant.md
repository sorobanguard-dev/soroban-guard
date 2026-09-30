# SEP-41 Conformance Report

| | |
| --- | --- |
| Contract | `CC4IRW5FEHQTV746SNKZPFWPGBHMSLU4QMJ2WON42CLKFB5TFQSYWZ4J` |
| Network | `https://soroban-testnet.stellar.org` |
| Run at | 2026-09-30T20:20:33.836Z |
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
| `sep41-name` | SEP-41 §name | required | PASS | name is "GUARD:GCAR3777F35UV7YPLUXD23QMQNR4RT5H6U6QP63LYZSCZNYYYB2U3TXL" |
| `sep41-symbol` | SEP-41 §symbol | required | PASS | symbol is "GUARD" |

### `sep41-decimals`

- expected: u32 decimal precision
- observed: returned 7
- ledger: 4955209

### `sep41-name`

- expected: string token name
- observed: name is "GUARD:GCAR3777F35UV7YPLUXD23QMQNR4RT5H6U6QP63LYZSCZNYYYB2U3TXL"
- ledger: 4955209

### `sep41-symbol`

- expected: string token symbol
- observed: symbol is "GUARD"
- ledger: 4955209

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
| `sep41-transfer_from-expired` | SEP-41 §transfer_from | required | PASS | a spend against an allowance that expired at ledger 4955223 was refused at ledger 4955224 |

### `sep41-balance`

- expected: non-negative balance for the holder
- observed: balance is 10000000000
- ledger: 4955209

### `sep41-allowance`

- expected: non-negative allowance from owner to spender
- observed: allowance is 0
- ledger: 4955209

### `sep41-transfer_from-unauthorized`

- expected: transfer_from refuses a spender with no allowance from the holder
- observed: an unauthorized spend was refused
- error: `Transaction simulation failed: "HostError: Error(Contract, #9)  Event log (newest first):    0: [Diagnostic Event] contract:CC4IRW5FEHQTV746SNKZPFWPGBHMSLU4QMJ2WON42CLKFB5TFQSYWZ4J, topics:[error, Error(Contract, #9)], data:["not enough allowance to spend", 0, 1]    1: [Diagnostic Event] topics:[fn_call, CC4IRW5FEHQTV746SNKZPFWPGBHMSLU4QMJ2WON42CLKFB5TFQSYWZ4J, transfer_from], data:[GB3MRHJWWPYNESICD3GOKDWLCBGLUAHMNJ6C3ZNDHAWPEDMZRISJ7A5N, GDIUFV657BJCMNU2JN4CCDYM3NTUNBI4X2GFTJDEUUHOJZVU337TDSYR, GB3MRHJWWPYNESICD3GOKDWLCBGLUAHMNJ6C3ZNDHAWPEDMZRISJ7A5N, 1] "`

### `sep41-transfer-zero-amount`

- expected: a transfer of zero leaves both balances unchanged
- observed: the call was accepted and both balances held, at 10000000000 and 0
- before: `{"holder":"10000000000","recipient":"0"}`
- after: `{"holder":"10000000000","recipient":"0"}`
- tx: `8a64e093239d5e9c8f78b11ac2390c630ffabd0e3e737e263d5f9e7ac66dcb2a`
- ledger: 4955211

### `sep41-transfer-self`

- expected: a transfer to oneself leaves the balance unchanged
- observed: the call was accepted and the balance held at 10000000000
- before: `{"holder":"10000000000"}`
- after: `{"holder":"10000000000"}`
- tx: `c8407396cc89c681551c9a4edc0718eb7b4b2bbf81c9ea3a1482aef12b60b0f5`
- ledger: 4955212

### `sep41-transfer-negative-amount`

- expected: transfer refuses a negative amount
- observed: a transfer of -1 was refused
- before: `{"holder":"10000000000","recipient":"0"}`
- error: `Transaction simulation failed: "HostError: Error(Contract, #8)  Event log (newest first):    0: [Diagnostic Event] contract:CC4IRW5FEHQTV746SNKZPFWPGBHMSLU4QMJ2WON42CLKFB5TFQSYWZ4J, topics:[error, Error(Contract, #8)], data:["negative amount is not allowed", -1]    1: [Diagnostic Event] topics:[fn_call, CC4IRW5FEHQTV746SNKZPFWPGBHMSLU4QMJ2WON42CLKFB5TFQSYWZ4J, transfer], data:[GDIUFV657BJCMNU2JN4CCDYM3NTUNBI4X2GFTJDEUUHOJZVU337TDSYR, GB3MRHJWWPYNESICD3GOKDWLCBGLUAHMNJ6C3ZNDHAWPEDMZRISJ7A5N, -1] "`

### `sep41-transfer-over-balance`

- expected: transfer refuses to move more than the holder's balance
- observed: a transfer of 10000000001 against a balance of 10000000000 was refused
- before: `{"holder":"10000000000","recipient":"0"}`
- error: `Transaction simulation failed: "HostError: Error(Contract, #10)  Event log (newest first):    0: [Diagnostic Event] contract:CC4IRW5FEHQTV746SNKZPFWPGBHMSLU4QMJ2WON42CLKFB5TFQSYWZ4J, topics:[error, Error(Contract, #10)], data:["resulting balance is not within the allowed range", 0, -1, 9223372036854775807]    1: [Diagnostic Event] topics:[fn_call, CC4IRW5FEHQTV746SNKZPFWPGBHMSLU4QMJ2WON42CLKFB5TFQSYWZ4J, transfer], data:[GDIUFV657BJCMNU2JN4CCDYM3NTUNBI4X2GFTJDEUUHOJZVU337TDSYR, GB3MRHJWWPYNESICD3GOKDWLCBGLUAHMNJ6C3ZNDHAWPEDMZRISJ7A5N, 10000000001] "`

### `sep41-transfer`

- expected: transfer moves the amount from holder to recipient
- observed: holder -1, recipient +1
- before: `{"holder":"10000000000","recipient":"0"}`
- after: `{"holder":"9999999999","recipient":"1"}`
- tx: `0017a3d341ec39621e28c14240c2073f77f0e7a1b912edc6d7715914d90addaf`
- ledger: 4955214

### `sep41-approve`

- expected: approve sets the spender's allowance to the given amount
- observed: allowance is 2 after approving 2 over 1
- before: `{"allowance":"0"}`
- after: `{"allowance":"2"}`
- tx: `ec5d5aadc91ec436fbd1291b4c632a8208448983e57232a8c03a14b910e6b77b`
- ledger: 4955216

### `sep41-transfer_from`

- expected: transfer_from moves the amount and consumes the spender's allowance
- observed: holder -1, recipient +1, allowance -1
- before: `{"holder":"9999999999","recipient":"1","allowance":"2"}`
- after: `{"holder":"9999999998","recipient":"2","allowance":"1"}`
- tx: `9221084d45f7eaba454e1513af03304e11ff5c8abb043b8c1bd1cfaaf127259a`
- ledger: 4955219

### `sep41-burn`

- expected: burn removes the amount from the holder's balance
- observed: holder -1
- before: `{"holder":"9999999998"}`
- after: `{"holder":"9999999997"}`
- tx: `40fa43d699a057ae01507df01949a289b17d9b95e82f99377140d173c608a9c8`
- ledger: 4955220

### `sep41-burn_from`

- expected: burn_from removes the amount from the holder and consumes the allowance
- observed: holder -1, spender 0, allowance -1
- before: `{"holder":"9999999997","spender":"2","allowance":"1"}`
- after: `{"holder":"9999999996","spender":"2","allowance":"0"}`
- tx: `3a301b98aae3acc3004fe09e88f9284b5b84b9ed09e8e4a4a7ebac3a44a71cb3`
- ledger: 4955221

### `sep41-transfer_from-expired`

- expected: transfer_from refuses a spend against an allowance whose live_until_ledger has passed
- observed: a spend against an allowance that expired at ledger 4955223 was refused at ledger 4955224
- before: `{"granted":"1","allowance":"0","holder":"9999999996","recipient":"2"}`
- ledger: 4955224
- error: `Transaction simulation failed: "HostError: Error(Contract, #9)  Event log (newest first):    0: [Diagnostic Event] contract:CC4IRW5FEHQTV746SNKZPFWPGBHMSLU4QMJ2WON42CLKFB5TFQSYWZ4J, topics:[error, Error(Contract, #9)], data:["not enough allowance to spend", 0, 1]    1: [Diagnostic Event] topics:[fn_call, CC4IRW5FEHQTV746SNKZPFWPGBHMSLU4QMJ2WON42CLKFB5TFQSYWZ4J, transfer_from], data:[GB3MRHJWWPYNESICD3GOKDWLCBGLUAHMNJ6C3ZNDHAWPEDMZRISJ7A5N, GDIUFV657BJCMNU2JN4CCDYM3NTUNBI4X2GFTJDEUUHOJZVU337TDSYR, GB3MRHJWWPYNESICD3GOKDWLCBGLUAHMNJ6C3ZNDHAWPEDMZRISJ7A5N, 1] "`

---

Generated by [soroban-guard](https://github.com/sorobanguard-dev/soroban-guard).
Each verdict describes the contract as it stood during this run. Writes move balances and allowances, so a later run against the same contract is a fresh check, not a replay of this one.

