# soroban-guard

[![CI](https://github.com/birserg/soroban-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/birserg/soroban-guard/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Conformance testing for deployed [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md)
Soroban token contracts on Stellar **testnet**.

> **Scope, stated plainly:** this checks **SEP-41 token contracts only**,
> and is built for **testnet**. Reads work against any network; the writes
> refuse to sign anywhere but a test network unless
> `--allow-non-testnet-write` is passed, and a full run burns real units
> where it lands. The name is broader than the tool — it does not audit
> arbitrary Soroban contracts, review WASM, or check any other SEP.
> A contract that passes here has been shown to honour the SEP-41
> interface as this suite exercises it; that is not a security audit, and
> no run of this tool should be read as one.

> **Status: early.** All ten SEP-41 members are checked against testnet.
> The five reads (`decimals`, `balance`, `allowance`, `name`, `symbol`) are
> observed; the five writes (`transfer`, `approve`, `transfer_from`, `burn`,
> `burn_from`) are performed — signed, submitted, and asserted against the
> balances and allowances they moved.
>
> Six further checks assert what a contract must *refuse* or must leave
> alone — an unauthorized spend, more than the balance, a negative amount,
> a lapsed allowance, a zero transfer, a self-transfer. These are the shape
> that catches a missing allowance check or a missing bounds check,
> because a contract lacking either behaves identically to a correct one
> whenever the request is legitimate. See
> [docs/check-reference.md](docs/check-reference.md) for what each proves
> and [docs/verification.md](docs/verification.md) for a run and its
> transaction hashes.

## Usage

Requires **Node 24** — the CLI runs its TypeScript sources directly via
type stripping, so there is no build step. Nothing else to configure:

```sh
pnpm install
node packages/soroban-guard/src/cli.ts <contract-id>
```

Against a real testnet token, with **nothing configured** — no keys, no
addresses. This is the first run, and it is mostly question marks by
design: thirteen checks need signing authority or a real holder, and each
one names what it needs instead of guessing. A configured run answers all
sixteen — see [Checking writes](#checking-writes) below for that output.

```
SEP-41 Conformance — CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM

  ✓ sep41-decimals  returned 7
  ? sep41-balance  balance is 0 on a generated probe address; set OWNER_ADDRESS for a real assertion
    expected: non-negative balance for the holder
  ? sep41-allowance  allowance is 0 between addresses that never interacted; set OWNER_ADDRESS and SPENDER_ADDRESS to a real approving pair
    expected: non-negative allowance from owner to spender
  ✓ sep41-name  name is "Comet Pool Token"
  ✓ sep41-symbol  symbol is "CPAL"
  ? sep41-transfer_from-unauthorized  no signing authority for the spender; set SPENDER_SECRET to attempt a spend the contract should refuse
    expected: transfer_from refuses a spender with no allowance from the holder
  ? sep41-transfer-zero-amount  no signing authority for the holder; set OWNER_SECRET to attempt a transfer that must not move value
    expected: a transfer of zero leaves both balances unchanged
  ? sep41-transfer-self  no signing authority for the holder; set OWNER_SECRET to attempt a transfer that must not move value
    expected: a transfer to oneself leaves the balance unchanged
  ? sep41-transfer-negative-amount  no signing authority for the holder; set OWNER_SECRET to attempt a transfer the contract should refuse
    expected: transfer refuses a negative amount
  ? sep41-transfer-over-balance  no signing authority for the holder; set OWNER_SECRET to attempt a transfer the contract should refuse
    expected: transfer refuses to move more than the holder's balance
  ? sep41-transfer  no signing authority for the holder; set OWNER_SECRET to an account that both signs and holds this token
    expected: transfer moves the amount from holder to recipient
  ? sep41-approve  no signing authority for the holder; set OWNER_SECRET to the account granting the allowance
    expected: approve sets the spender's allowance to the given amount
  ? sep41-transfer_from  transfer_from needs both keys: OWNER_SECRET to grant the allowance and SPENDER_SECRET to spend it
    expected: transfer_from moves the amount and consumes the spender's allowance
  ? sep41-burn  no signing authority for the holder; set OWNER_SECRET to an account that both signs and holds this token
    expected: burn removes the amount from the holder's balance
  ? sep41-burn_from  burn_from needs both keys: OWNER_SECRET to grant the allowance and SPENDER_SECRET to spend it
    expected: burn_from removes the amount from the holder and consumes the allowance
  ? sep41-transfer_from-expired  expired-allowance needs both keys: OWNER_SECRET to grant the allowance and SPENDER_SECRET to attempt the spend
    expected: transfer_from refuses a spend against an allowance whose live_until_ledger has passed

3 pass, 0 fail, 0 skipped, 13 unverifiable, 0 not implemented (16 checks)
by layer: interface 3/3 pass · behavior 0/13 pass
```

Every non-passing row says what it needs, so the report never implies
coverage it does not have. A member no check assessed would appear the same
way, as an explicit row rather than a silent omission.

An unconfigured run generates probe addresses and funds the owner from
Friendbot. A generated probe holds none of the token under test, so balance
and allowance report `UNVERIFIABLE` rather than a vacuous pass. Point them at an address that
actually holds the token for a real assertion:

```sh
OWNER_ADDRESS=G... SPENDER_ADDRESS=G... \
  node packages/soroban-guard/src/cli.ts <contract-id>
```

### Checking writes

Five members change state, so they have to be signed. Without a key they
report `UNVERIFIABLE` — never `FAIL`, because a missing key says nothing
about the contract. `transfer` and `burn` need the holder's key;
`transfer_from` and `burn_from` also need the spender's, since the clause
specifies `spender.require_auth()`. Those two establish their own allowance
rather than depending on `approve` having run first, so each check can be
run alone:

```sh
OWNER_SECRET=$(stellar keys secret owner) \
SPENDER_SECRET=$(stellar keys secret spender) \
  node packages/soroban-guard/src/cli.ts <contract-id>
```

With both keys configured, every row carries a verdict — this is a real
run against a Stellar Asset Contract on testnet:

```
SEP-41 Conformance — CARQGEM3RDSWA2SRZDL6LDBOEQWQHS74BOL5V62QXIGMOBIMIX5YTYYN

  ✓ sep41-decimals  returned 7
  ✓ sep41-balance  balance is 898999960
  ✓ sep41-allowance  allowance is 0
  ✓ sep41-name  name is "TEST:GAY3IYUGLOBCIFRCDULGBSR4VYREU4BITUAIYTUD64KN232LJBOHSUGY"
  ✓ sep41-symbol  symbol is "TEST"
  ✓ sep41-transfer_from-unauthorized  an unauthorized spend was refused
  ✓ sep41-transfer-zero-amount  the call was accepted and both balances held, at 898999960 and 14
  ✓ sep41-transfer-self  the call was accepted and the balance held at 898999960
  ✓ sep41-transfer-negative-amount  a transfer of -1 was refused
  ✓ sep41-transfer-over-balance  a transfer of 898999961 against a balance of 898999960 was refused
  ✓ sep41-transfer  holder -1, recipient +1
  ✓ sep41-approve  allowance is 2 after approving 2 over 1
  ✓ sep41-transfer_from  holder -1, recipient +1, allowance -1
  ✓ sep41-burn  holder -1
  ✓ sep41-burn_from  holder -1, spender 0, allowance -1
  ✓ sep41-transfer_from-expired  a spend against an allowance that expired at ledger 4903103 was refused at ledger 4903104

16 pass, 0 fail, 0 skipped, 0 unverifiable, 0 not implemented (16 checks)
by layer: interface 3/3 pass · behavior 13/13 pass

exit 0
```

And against a token written to be wrong — `fixtures/vulnerable-token`,
which exists so the checks can be proven to fire — the same suite reports
findings rather than a wall of red:

```
  ✓ sep41-transfer-zero-amount  the call was accepted and both balances held, at 1000 and 0
  ✗ sep41-transfer-self  the holder's balance moved from 1000 to 1001; debiting and crediting the same address must net zero, so a change means one side was applied without the other
  ✗ sep41-transfer-negative-amount  a transfer of -1 succeeded; the holder gained, consistent with the contract reading it as a transfer in the opposite direction — anyone can withdraw from anyone
  ? sep41-transfer-over-balance  recipient balance unreadable (balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted); cannot establish that neither party is the asset issuer

9 pass, 2 fail, 0 skipped, 5 unverifiable, 0 not implemented (16 checks)

exit 1
```

Three exit codes, so a pipeline can gate on the answer rather than parse
the text: **0** conformant, **1** the contract did not meet the standard —
either a check failed or a required member is not implemented — and **2**
no verdict was reached. Both runs above are logged row-for-row in
[docs/verification.md](docs/verification.md), alongside the transaction
hashes an earlier keyed run produced.

Each secret settles its own address, so `*_ADDRESS` is redundant alongside
it — supply both only if you want the mismatch checked. Each write acts on
**1 unit**, the smallest amount that proves movement, and reports the
before/after quantities with the transaction hash and ledger.

Use a spender that holds no allowance yet. Two checks need that absence as
their premise — `transfer_from-unauthorized` has nothing to violate
otherwise, and `approve` cannot observe a change if the allowance already
equals the amount it would set. Both report UNVERIFIABLE rather than guess,
so a second run against the same pair assesses less than the first. A fresh
spender restores full coverage. A fresh spender needs the same setup as
any other: funding, a trustline to the asset, and its signing key in
`SPENDER_SECRET` — otherwise the checks report UNVERIFIABLE for the lack
of standing rather than assessing anything.

A full run is destructive in small ways worth knowing about: `burn` and
`burn_from` each destroy one unit, irreversibly. `transfer` and
`transfer_from` move one unit each to the spender. `approve` moves nothing
but overwrites any standing allowance between the pair, while the two
`_from` checks consume one rather than overwriting it.

The six negative checks move no tokens on a conformant one: four attempt
something the contract must refuse — a spend with no allowance, more than
the balance, a negative amount, a lapsed allowance — and two move nothing
by construction, a zero transfer and a self-transfer. They are not all
free, though. The four refusals are rejected at simulation and never reach
the ledger. The zero and self transfers settle *if the contract accepts
them* — which it may, since SEP-41 permits either answer and the assertion
is that the balances held — and a settled call costs its fee. A contract
that refuses them instead is equally conformant and pays nothing. `transfer_from-expired` additionally submits a real
setup approval, overwriting any standing allowance between the pair with a
grant that lapses within two ledgers. A token that does not refuse the
first four spends more than this, which is the finding those checks exist
to produce.

So a holder needs five units plus XLM for fees to be assessed on every
check — four that the writes spend, and a fifth that `transfer_from-expired`
needs present when it runs last, though it spends nothing. With less, the
later checks honestly report UNVERIFIABLE. One
caveat on time rather than tokens: `transfer_from-expired` has to wait for
a ledger to pass before it can spend, which adds about ten seconds to a
keyed run.

> **Testnet only, by default.** This signs and submits real transactions, so
> a run that holds a secret exits before touching the network unless two
> things agree: the passphrase must be a test network (or
> `--allow-non-testnet-write` given), and the RPC endpoint must not
> contradict it. Funding is check-first, so neither can be caught by the
> faucet — an already-funded mainnet account would otherwise sail straight
> through. Reads run anywhere and sign nothing.
>
> Recipient control is enforced per check rather than at that gate: a
> generated `SPENDER_ADDRESS` has a key this process discards at exit, so
> any check that would move a unit to it reports UNVERIFIABLE instead.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | every required member assessed and conformant |
| `1`  | a verified violation |
| `2`  | unknown — the run failed, or members went unassessed |

`0` requires every required member to have been assessed and passed, which
in practice means a run configured with both keys against a token the
holder actually holds. Anything less reports `2`: a member the suite could
not exercise is unknown, not conformant.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## Why

SEP-41 is the standard token interface for Soroban. A Stellar Asset
Contract is the protocol's own implementation of it — the same code for
every classic asset, so its arithmetic is not something an issuer writes
or can get wrong. A custom token is just a contract, written by whoever
deployed it, and nothing stops one from implementing the interface
correctly while behaving incorrectly.

(The protocol guaranteeing a SAC's arithmetic is a narrow promise: a
classic asset's issuer can still freeze, claw back, or issue more. This
tool checks the interface's behaviour, not an issuer's intentions — see
[Scope](#scope).)

Existing tooling checks that a contract _exports_ the right functions. That
cannot distinguish a correct `transfer` from one that never compares the
amount against the balance and lets a holder spend units that were never
issued, or one that reads a negative amount as a transfer in the opposite
direction. `fixtures/vulnerable-token` in this repository does exactly
those things while exporting all ten members with the right signatures.
Those failures are behavioural, and behaviour requires execution. That is why the write clauses are checked by
actually performing them: the guard reads the balances and allowances involved,
submits a signed call, reads them again, and reports the deltas with the
transaction hash and ledger as evidence. The negative checks go the other
way — they attempt what a contract must refuse and pass only when it does,
which is the shape a missing bounds check cannot survive. What that shape
covers, and what it does not, is set out under
[Authorization](#what-a-passing-report-does-not-mean) below.

`soroban-guard` takes a deployed contract address, exercises it against a
live network, and reports which SEP-41 clauses it satisfies.

## Scope

Conformance, not security. A passing report does **not** mean a token is safe:
it says nothing about admin mint capability, upgradeability, or blacklists —
all of which are SEP-41-conformant and all of which can still cause loss.

A passing `transfer` does not by itself mean the contract checks
authorization: an authorized move landing proves the happy path, not the
refusal. `transfer_from-unauthorized` is what tests the other direction — it
attempts a spend with no allowance and PASSes only when the contract refuses
it. That is one clause covered this way; `transfer` and `burn` have no
equivalent negative check yet, so a token missing `from.require_auth()`
would still pass those.

One judgement worth stating: a fee-on-transfer token, which credits the
recipient less than it debits the sender, **FAILs** here. SEP-41 gives
`transfer` no fee semantics, so crediting a different amount than was debited
is a violation of the clause as written, not a variation the tool tolerates.

## Current limitations

* Testnet only. Never place mainnet keys in `.env`.
* Validated against a SAC (Stellar Asset Contract) token and against a
  purpose-built broken WASM token. No check is SAC-specific: members are
  called by name, and a WASM contract's spec is the richer path — it says
  which members are declared, so undeclared ones report NOT_IMPLEMENTED
  without spending a call, where a SAC has no spec and every member is
  attempted blind. What is *not* yet proven is a conformant custom WASM
  token: the passing runs in [docs/verification.md](docs/verification.md)
  are all against a SAC, so a false FAIL specific to WASM tokens would not
  have been caught yet.
* The negative checks are proven to fire. A token that passes every check
  tells you nothing on its own — a check that never fires looks exactly
  like one that fires correctly. `fixtures/vulnerable-token` is a SEP-41
  token written to be wrong in named ways, and the guard reports two of
  them as failures — a self-transfer that nets the amount, and a negative
  amount taken as a direction — while still passing the nine checks it
  should. The other two flaws report UNVERIFIABLE rather than FAIL: the
  negative amount leaves an account below zero, and a contract whose
  accounting is already unsound cannot have its remaining rules tested in
  the same run. See its [README](fixtures/vulnerable-token/README.md) and
  the 2026-09-27 entries in
  [docs/verification.md](docs/verification.md).
* SAC specifics the checks actually observe: `balance` and `allowance`
  against an address with no trustline trap with "trustline entry is
  missing", which is reported UNVERIFIABLE — no standing to ask — rather
  than FAIL. The issuer's own balance reads `i64::MAX` (issuers mint on
  payout), so it cannot anchor a balance assertion. `transfer` refuses to
  judge any run the issuer takes part in — sending from one mints and
  sending to one burns, so neither side's delta means what it appears to —
  and reports UNVERIFIABLE before spending a ledger close.

  SEP-41 itself draws none of these distinctions: a SAC and a custom token
  implement the same interface, and every check calls members by name
  without asking which it is talking to. What differs is what the *guard*
  infers. Two of those inferences are value-based rather than type-based,
  so a custom token could trip them by coincidence: a balance of exactly
  `i64::MAX` is read as an issuer sentinel, and a trap whose text matches
  the SAC host's trustline wording is downgraded to UNVERIFIABLE. Both
  fail safe — they withhold a verdict rather than invent one — but a
  custom token holding 922 billion units of a 7-decimal asset would be
  skipped where a SAC issuer would be.
* Events are not observed. The writes land and their deltas are asserted,
  but no check reads the topics a contract emits — so a token that moves
  balances correctly while emitting wrong or missing `transfer` events
  passes. Nothing populates `evidence.events`, and the `events` layer is a
  label with no checks behind it.
* `approve` sets an expiration 17,280 ledgers ahead (roughly a day) and
  does not verify it was stored: `allowance()` returns the amount alone,
  never its `live_until_ledger`.

## License

Apache-2.0
