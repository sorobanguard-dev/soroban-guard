# Checks reference

What each of the sixteen checks proves, needs, and reports, in the order the
suite runs them: five reads first, since they are cheap and need no keys;
then five of the six negative checks, which cost nothing on a conformant token and
whose premises the writes below would destroy; then the five writes that
actually move value. The sixth, the expiry check, runs last, because it is the
only one that waits on a ledger to close.

Within that middle group the order is itself a safety property, and matters
only when the contract is broken — which is exactly when a verdict is worth
having. A refusal check that the contract *ignores* moves what it offered,
so they run least-destructive first: a zero transfer moves zero and a
self-transfer nets zero whatever the arithmetic does, a negative amount
shifts a single unit, and `balance + 1` takes everything and leaves the
holder below zero. Once that happens the contract's accounting is unsound
and every later check reads the damage instead of testing its own rule, so
`over-balance` goes last among them. The suite's ordering rules are pinned
by unit test rather than left to the comments.

A premise is what must be true *before* the check can say anything at all.
When a premise is missing the check reports UNVERIFIABLE — never FAIL,
because a missing key, an empty holder, or an unreadable balance is a fact
about the run, not about the contract.

## Reads

### `sep41-decimals` — interface

`decimals()` returns the token's decimal precision: a non-negative integer.
Any `u32` passes; an implausible one passes with the anomaly visible in the
message rather than failing a spec-legal value.

### `sep41-balance` — behavior

`balance()` returns a non-negative holding for the holder address. A
generated probe reporting `0` is UNVERIFIABLE instead of a vacuous pass —
`0` distinguishes nothing, while any other value rules out an always-zero
bug and PASSes.

### `sep41-allowance` — behavior

`allowance()` returns a non-negative approval from holder to spender. Same
probe rule as balance: `0` on a generated pair is UNVERIFIABLE.

### `sep41-name` — interface

`name()` returns a string. Empty is spec-legal, so it passes with the
anomaly visible rather than failing a contract the spec allows.

### `sep41-symbol` — interface

As `name`: any string passes, empty included, anomaly visible.

## Writes

Most writes move **1 unit**, sign, submit, and assert the before/after
state with the transaction hash and ledger as evidence — but the family
varies: `transfer_from-unauthorized` passes on a refusal and records the
refusal's error text instead of a transaction, and `approve` sets an
absolute allowance (including a confirming second approval of 2) rather
than a delta.

A holder needs roughly four units plus XLM for fees for the full suite to
assess everything; with less, later checks honestly report UNVERIFIABLE.
Four rather than one per write, because only `transfer`, `transfer_from`,
`burn` and `burn_from` spend anything on a conformant token: the refusal
checks are refused, the zero transfer moves nothing, and the self-transfer
returns what it sends. A token that does *not* refuse them spends more —
which is itself the finding.

### `sep41-transfer_from-unauthorized` — behavior

Attempts a spend with no allowance and **passes only when the contract
refuses** — the inverted mapping that catches a missing `require_auth()`,
which no positive check can distinguish. Premise: the spender holds no
allowance, the holder holds something worth taking, neither party is the
asset issuer, the holder and spender differ, the spender is not a generated
address, and the spender's signer signs as the spender. Needs the spender's
key. Runs before `approve`, which would otherwise grant the allowance whose
absence is the premise.

### `sep41-transfer-over-balance` — behavior

Attempts to move `balance + 1` and **passes only when the contract
refuses** — a balance is a count of units that exist, so a transfer taking
it below zero has nothing to move. A contract that allows it either mints
silently or wraps the subtraction, and both let a holder spend value that
was never issued. Invisible to `sep41-transfer`, which moves an amount the
holder does own and behaves identically either way.

One unit past the balance rather than a huge number: a contract could
reject `u128::MAX` for an encoding reason that says nothing about its
arithmetic. Premise: the holder's balance is readable, neither party is the
asset issuer, the two differ, and the recipient is not a generated address
— a contract that wrongly allowed this would move the whole balance
somewhere unrecoverable. Needs the holder's key. Runs before the spending
writes, which would otherwise leave `balance + 1` equal to 1, refusable for
having nothing at all rather than for checking a floor.

### `sep41-transfer-negative-amount` — behavior

Attempts a transfer of `-1` and **passes only when the contract refuses**.
SEP-41 types amounts as `i128`, which is signed, so a negative value
encodes cleanly and reaches the contract. The obvious implementation of one
is a reversed transfer: `transfer(attacker, victim, -1)` debits the victim
while the authorization check passes on the attacker — anyone can withdraw
from anyone. On a FAIL the direction the balance moved names which bug it
is: the holder gaining means the sign was honoured and the transfer ran
backwards; the holder losing means the sign was discarded; an unchanged
balance means the call was accepted without moving anything. Premises
match over-balance; needs the holder's key.

### `sep41-transfer-zero-amount` — behavior

Transfers `0` and asserts the balance **did not change**. Unlike the
refusal checks, both answers are conformant: SEP-41 imposes no rule on a
zero amount, so a contract may accept it as a no-op or reject it, and
asserting "must reject" would invent a requirement and FAIL a correct
token. The FAIL is a balance that moved — a contract minting or burning on
a zero transfer. Needs the holder's key and a distinct recipient; no
minimum balance, since zero moves nothing even from an empty account.

### `sep41-transfer-self` — behavior

Transfers one unit from the holder to itself and asserts the balance
**netted zero**. Same rule as the zero case: refusing and accepting are
both conformant, so only a change is a finding — a contract that debits
without crediting when both addresses match loses a unit on every
self-send. Needs the holder's key and at least one unit, or a refusal would
mean "empty account" rather than anything about self-transfers. The
recipient is the holder by construction, so `SPENDER_ADDRESS` is
irrelevant.

### `sep41-transfer` — behavior

Moves one unit from holder to recipient and asserts holder `-1`,
recipient `+1` exactly — a fee-on-transfer token FAILs here, correctly
against SEP-41, which gives transfer no fee semantics. Needs the holder's
key; the signing key must sign as the holder, the recipient must be a
distinct, non-generated, non-issuer address, and a non-issuer holder needs
a balance. Proves liveness only: it does not show the contract would refuse
an unauthorized move.

### `sep41-approve` — behavior

Sets the allowance to exactly 1 (overwriting, per the spec) and asserts
the exact value — including a second approval of 2 when starting from
zero, where overwrite and accumulate agree. Needs the holder's key.
Assertion is absolute, not a delta. Does not check the stored expiration:
`allowance()` returns the amount alone.

### `sep41-transfer_from` — behavior

Moves one unit holder → spender as the spender and asserts holder `-1`,
recipient `+1`, allowance `-1` — the draw-down is the distinguishing
requirement. Needs both keys. Establishes its own allowance when none
suffices; consumes a standing one when it does (never overwrites it).

### `sep41-burn` — behavior

Destroys one unit of the holder's balance and asserts `-1`. Irreversible.
Needs the holder's key. Cannot show supply actually fell — SEP-41 declares
no `total_supply`, so a mint elsewhere during the burn is invisible.

### `sep41-burn_from` — behavior

Burns one unit as the spender, asserting holder `-1`, allowance `-1`, and
spender `0` — a debited spender alongside would be double-spending. Needs
both keys. Irreversible.

### `sep41-transfer_from-expired` — behavior

Approves a grant with a deliberately short `live_until_ledger`, waits for
the ledger to pass it, then spends — and **passes only when the contract
refuses**. A contract that stores the amount and ignores the deadline
leaves every approval permanent: a spender authorized once can return
later and spend again. No read distinguishes the two, because
`allowance()` returns the amount alone and never the ledger it dies at.

The only check that creates the condition it tests, and the only one that
waits on wall-clock time — roughly ten seconds, bounded at 45. A network
that does not advance reports UNVERIFIABLE rather than hanging. Its grant
is deliberately **not** recorded in the run's allowance registry: that
registry means "fresh, so a refusal is the contract's answer", which is
the opposite of a grant built to lapse. Needs both keys, a funded holder,
and non-issuer parties. Runs last, so its wait delays nothing else.
Side effect to know: the setup approval overwrites any standing allowance
between the pair with a grant that lapses within two ledgers — after the
run the operator's grant is effectively zero, even where `approveCheck`
left it alone. Unlike the `_from` checks, which consume rather than
replace, this one cannot test expiry without granting first.

## Verdicts

- `PASS` — the clause was exercised and held.
- `FAIL` — the clause was exercised and was violated.
- `UNVERIFIABLE` — the clause could not be exercised; no verdict either way.
- `SKIPPED` — the check could not run (harness or network failure). A
  submitted transaction that timed out is not this: it reports
  UNVERIFIABLE, since it may still apply.
- `NOT_IMPLEMENTED` — the contract does not declare this member (WASM
  spec introspection; SACs have no spec, so every member is attempted).

Exit codes follow: `0` conformant, `1` violation, `2` unknown. Anything
unassessed appears as an explicit `UNVERIFIABLE` row rather than a silent
omission.
