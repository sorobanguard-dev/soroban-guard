# Verification log

Evidence that the write checks reach the ledger, kept because a report in a
terminal is not evidence anyone else can check. Every hash below is on
Stellar testnet and can be looked up on any explorer.

## Reproducing it yourself

The fixture is a Stellar Asset Contract the operator issues, so anyone can
build the same setup without needing a token they do not control. A SAC
because it takes four steps to issue one — the guard itself is
contract-agnostic and calls SEP-41 members by name, so a custom WASM token
is tested the same way, and better informed: its spec says which members
are declared, so undeclared ones report NOT_IMPLEMENTED without spending a
call. A SAC has no spec, so every member is attempted blind.

Steps:

1. Generate three keypairs and fund them from Friendbot (issuer, owner,
   spender).
2. Have the owner and spender each establish a trustline to an asset the
   issuer controls, and pay the owner some of it.
3. Deploy the asset's SAC (`createStellarAssetContract`).
4. Run the guard with both secrets set.

```sh
OWNER_SECRET=$(stellar keys secret owner) \
SPENDER_SECRET=$(stellar keys secret spender) \
  node packages/soroban-guard/src/cli.ts <contract-id>
```

One caveat worth knowing before you try: `transfer_from-unauthorized`
requires the spender to hold **no** allowance, since that absence is the
premise it tests. Re-running against a pair that has already been through
`approve` reports UNVERIFIABLE rather than a verdict — use a fresh spender
(funded, trustlined to the asset, key in `SPENDER_SECRET`),
or read the guard's message, which says exactly this.

## Run of 2026-09-19

Against `CAJLPKZHDCHRMELESHIYGTRR2SXKEQMYWNNGLOLIZ4U2HLGHTXZXSLLY`, a SAC
for a test asset, with both keys configured.

> This log is what that run printed, kept as it was. The suite has grown
> since — five negative checks landed after it, so a run today reports
> sixteen rows rather than eleven, and those five have not yet been
> exercised against a live contract. A log is evidence of what happened,
> so it is appended to rather than edited; the newer checks will appear in
> their own dated entry.

```
SEP-41 Conformance — CAJLPKZHDCHRMELESHIYGTRR2SXKEQMYWNNGLOLIZ4U2HLGHTXZXSLLY

  ✓ sep41-decimals  returned 7
  ✓ sep41-balance  balance is 4999999967
  ✓ sep41-allowance  allowance is 0
  ✓ sep41-name  name is "GSVQU:GB77UX7L5ZULBK5ZWZ5AEBUJG5CBDLHO4GRYGC2KAOXKA5MDV5DYGNBI"
  ✓ sep41-symbol  symbol is "GSVQU"
  ✓ sep41-transfer  holder -1, recipient +1
  ✓ sep41-transfer_from-unauthorized  an unauthorized spend was refused
  ✓ sep41-approve  allowance is 1 after approving 1
  ✓ sep41-transfer_from  holder -1, recipient +1, allowance -1
  ✓ sep41-burn  holder -1
  ✓ sep41-burn_from  holder -1, spender 0, allowance -1

11 pass, 0 fail, 0 skipped, 0 unverifiable, 0 not implemented (11 checks)
by layer: interface 3/3 pass · behavior 8/8 pass

exit 0
```

### Transactions that run produced

| Function | Transaction |
| -------- | ----------- |
| `transfer` | `3b2b43647caaa87e125e5c53179ba19770a676bbe14d37d48967ce024b25a303` |
| `approve` | `2542d5d93aa48dea2d683cde4223e93179828edcddb67363f43da912ab0be07e` |
| `transfer_from` | `07983908014b5b45b23bb187d9b032f32fd1e3187ed181833b4843687d75a284` |
| `burn` | `c2053e5e29d7941fe4c843542469ecad373b7c754d2bca72deddd94282699cdd` |
| `burn_from` | `0fc55442ca2fe51a40ad36596194011d8d431d94a23657f243af4f3e6a840f4a` |

`transfer_from-unauthorized` produced no transaction, which is the point:
the contract refused it at simulation, so nothing reached the ledger.

## What this does and does not establish

It establishes that the write path signs, submits, settles and measures
against a real contract — and that a refusal-shaped requirement is asserted
correctly at least once.

It does not establish behaviour against a **custom WASM token**. Every run
here is against a Stellar Asset Contract, whose implementation is native to
the protocol and shared by every classic asset. A SAC cannot be
non-conformant in an interesting way; the tokens that can are the ones
someone wrote in Rust, and none has been tested yet. That gap is the reason
`transfer_from-unauthorized` matters most against a deployed vulnerable
fixture, which remains unbuilt.

> Superseded by the run of 2026-09-27 below, which exercises the five
> negative checks live and builds the vulnerable fixture this paragraph
> calls for. Left as written, because a log that is edited when it becomes
> inconvenient is not evidence.

## Run of 2026-09-27 — the negative checks, against a conformant token

Against `CARQGEM3RDSWA2SRZDL6LDBOEQWQHS74BOL5V62QXIGMOBIMIX5YTYYN`, a SAC
for the TEST asset, with both keys configured and a **fresh spender** so
`transfer_from-unauthorized` has its premise (no standing allowance) intact.

```
16 pass, 0 fail, 0 skipped, 0 unverifiable, 0 not implemented (16 checks)
by layer: interface 3/3 pass · behavior 13/13 pass
exit 0
```

The five rows that had never run live before:

```
  ✓ sep41-transfer-zero-amount  the call was accepted and both balances held, at 898999980 and 4
  ✓ sep41-transfer-self  the call was accepted and the balance held at 898999980
  ✓ sep41-transfer-negative-amount  a transfer of -1 was refused
  ✓ sep41-transfer-over-balance  a transfer of 898999981 against a balance of 898999980 was refused
  ✓ sep41-transfer_from-expired  a spend against an allowance that expired at ledger 4895392 was refused at ledger 4895393
```

Run three times; identical verdict each time, with the holder's balance
tracking down as the writes spent it and `over-balance` recomputing
`balance + 1` from live state on each run.

### Transactions that run produced

| Check | Transaction |
| ----- | ----------- |
| `transfer-zero-amount` | `4a6129a464ff08db5eb2d83f6861508b6f0798ea86885f52a3a42882f191c8aa` |
| `transfer-self` | `2969d5ffd800aa79a577b8e03b2c57d15026ec418c9fb1b629a2d059c04fa7dc` |
| `transfer` | `17dcefa66339200ba744be506b9726d8c32a462a057db668d1d764f1d5a1a551` |
| `approve` | `9517b3f5e8ba9e502c1c7c1e8b909ee9f387b1fa8f5f181758b7c910d9ef5ca2` |
| `transfer_from` | `15f5690fb74ddea06d94c1ac0d7920dd0dc310729af7b3e1cec79a3b0a68a679` |
| `burn` | `bebdd4730b024264180f37f4e37629178e8af0a54a7481c1406d4b7a6cff28ea` |
| `burn_from` | `559dea4f68b9c02a249ca4bf8ad5dc364d5669939d4e59209db8c1cbf11ddb57` |

The three refusal checks produced **no transaction**, and that is the
result, not a gap: the contract refused each at simulation, so nothing
reached the ledger. The two invariance checks did settle, because a
contract is permitted to accept them and the assertion is that the
balances did not move.

`transfer_from-expired` settles a transaction of its own that is not in
the table above: its *setup* approval, which has to reach the ledger
before there is an expiring grant to spend against. The spend that follows
is refused at simulation like the others.

That setup hash is **not** carried in the check's PASS evidence — only the
balances, the expiry ledger and the refusal diagnostics are. So a
conformant run leaves a transaction on-chain that the report does not cite,
and the hash appears only when the setup *fails*, where it is the handle on
what went wrong. Worth knowing when reading a run: a hash from this check
means the setup did not work, not that the contract failed.

The same contract with **no secrets but both addresses set** reports
`5 pass, 0 fail, 11 unverifiable` and exits 2: the five reads answer, and
every check that would have to sign says what it needs rather than
guessing. Supplying neither secrets nor addresses reports `3 pass, 13
unverifiable` instead — the README's sample run — because `balance` and
`allowance` then read a generated probe, and `0` on an address that never
held anything distinguishes a working contract from an always-zero bug not
at all. Reads need addresses; only writes need keys.

### When the same run reports 15 pass, 1 unverifiable

Later runs against this contract reported `15 pass, 0 fail, 1 unverifiable`
and exit 2, with `transfer_from-expired` saying "could not establish a
short-lived allowance; approve must work before expiry can be assessed"
over a settled transaction
(`37450fb73341d65a999dc2499d8fc9f6ac6dbdf9f04c6385dfe15e2fe104d3fc`).

That is not a regression. The transaction's result XDR decodes to
`INVOKE_HOST_FUNCTION_ENTRY_ARCHIVED`: Soroban archives ledger entries
that go unread for long enough, and the allowance entry for this pair had
gone cold between runs, so the setup approval failed on-chain rather than
being refused by the contract.

It is worth keeping because it is the refusal ladder working. A settled
on-chain failure is never credited as a contract refusal — the check
reported UNVERIFIABLE with the hash and said which step failed, rather
than blaming the contract for a network condition. Restoring the entry, or
running against a contract whose entries are live, returns the run to
16/16.

## Run of 2026-09-27 — against a deliberately broken token

The gap the section above names is now closed. `fixtures/vulnerable-token`
is a SEP-41 token written to fail specific checks; see its README for what
each flaw is and how to deploy one. Against
`CDYOSYSK6C334LXIZULHLKOYRKF4HBQHLK7EIH5VEHQDCTJIBPZOHGXY`, every row as
the run printed it:

```
  ✓ sep41-decimals  returned 7
  ✓ sep41-balance  balance is 1000
  ✓ sep41-allowance  allowance is 0
  ✓ sep41-name  name is "Vulnerable Test Token"
  ✓ sep41-symbol  symbol is "VULN"
  ✓ sep41-transfer_from-unauthorized  an unauthorized spend was refused
  ✓ sep41-transfer-zero-amount  the call was accepted and both balances held, at 1000 and 0
  ✗ sep41-transfer-self  the holder's balance moved from 1000 to 1001; debiting and crediting the same address must net zero, so a change means one side was applied without the other
  ✗ sep41-transfer-negative-amount  a transfer of -1 succeeded; the holder gained, consistent with the contract reading it as a transfer in the opposite direction — anyone can withdraw from anyone
  ? sep41-transfer-over-balance  recipient balance unreadable (balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted); cannot establish that neither party is the asset issuer
  ? sep41-transfer  balances unreadable; cannot establish a before state to compare against
  ✓ sep41-approve  allowance is 2 after approving 2 over 1
  ? sep41-transfer_from  balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted; cannot establish a before state to compare against
  ✓ sep41-burn  holder -1
  ? sep41-burn_from  spender balance unreadable; cannot establish that the burn leaves it untouched
  ? sep41-transfer_from-expired  recipient balance unreadable (balance() returned -1, which is negative; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted); cannot establish that neither party is the asset issuer

9 pass, 2 fail, 0 skipped, 5 unverifiable, 0 not implemented (16 checks)
by layer: interface 3/3 pass · behavior 6/13 pass
exit 1
```

This is the run that makes the others mean something. Sixteen passes
against a SAC prove only that the guard does not cry wolf on a contract
that is correct by construction; a check that never fires looks exactly
like a check that fires correctly, until something deserves a red mark.

Four points worth drawing out:

- **Two flaws are demonstrated here, not four.** `negative-amount` fires
  and leaves the recipient at `-1`, so the accounting is unsound from that
  point on: `over-balance` and `transfer_from-expired` both report
  UNVERIFIABLE with the reason rather than testing their own rule. The
  floor and the missing expiry are genuinely untested in *this* run —
  their coverage is the unit tests, not this log. That is the tool being
  honest, and it is a property of the *contract*, not of the ordering: a
  token with several arithmetic holes cannot have all of them exercised in
  one run, because the first unrefused hole destroys the premises the rest
  need. Ordering only decides which ones get through — reversed, three
  checks are pre-empted instead of two.
- **`transfer-self` was not a planted flaw.** The fixture was written with
  three deliberate bugs and this was not among them — `transfer` reads both
  balances into locals before writing either, so when `from == to` the
  second write clobbers the first. The guard found it, and described it
  more precisely than the fixture's own comment did.
- **`zero-amount` passes on the same broken code path**, because zero nets
  zero even through that aliasing. That is exactly why the two invariance
  checks are separate rather than one.
- **The verdict is a mix, not a wall of red.** Nine passes, two failures,
  five unverifiable. A tool that failed everything against a broken
  contract would prove only that it disliked the contract.

The negative amount was also confirmed independently of the guard, by
invoking the contract directly — transaction
`b24e690d38dcc9844967cba898170e26f8c62caf20f8e3bc9aca739cccb1a6a5`, which
moved the holder from `1000` to `1100` and the recipient from `0` to
`-100`. The transfer ran backwards: the holder's signature withdrew from
the recipient. That is ground truth for the check that asserts it.

### Why a broken contract reports five unverifiable rows

Once `negative-amount` goes unrefused, the *recipient* holds `-1`: the
contract read the sign as a direction and debited the party that never
authorized anything. The holder is fine — it gained — but a balance below
zero is not a quantity SEP-41 admits, so every later check that reads that
account meets unsound accounting while establishing its own premise. They
report UNVERIFIABLE with the reason rather than FAIL, because the defect
has been named once already and repeating it would bury the finding among
its own consequences. See `soundness` on `Sep41Context`.

Note what this does *not* cover: a check reading only accounts that still
read positive gets a clean verdict. `burn` passes in the log above for
exactly that reason — it measures the holder, which is at `1002` and
falling by one as asked. The flag records that a quantity read negative,
not that the contract's arithmetic is unsound everywhere, so a PASS after
one is a statement about what that check measured rather than a clean bill
of health for the contract.

This is also why those four checks run least-destructive first
(`zero → self → negative-amount → over-balance`): ordered the other way,
the same contract reports one failure and eight unverifiable rows, and two
real defects go untested. Pinned by unit test in `suite.test.ts`.
