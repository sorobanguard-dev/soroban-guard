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
reached the ledger. The two invariance checks did settle — they are the
only negative checks that submit against a conformant token, because a
contract is permitted to accept them, and the assertion is that the
balances did not move.

A run with no keys configured reports `5 pass, 0 fail, 11 unverifiable`
and exits 2: every check that cannot act says so rather than guessing.

## Run of 2026-09-27 — against a deliberately broken token

The gap the section above names is now closed. `fixtures/vulnerable-token`
is a SEP-41 token written to fail specific checks; see its README for what
each flaw is and how to deploy one. Against
`CCUXRTRKO6QBOL6E5Q55M34G5CIC3UGCSJWGQPZHVI55OO2WLS2YLKLN`:

```
  ✓ sep41-transfer_from-unauthorized  an unauthorized spend was refused
  ✓ sep41-transfer-zero-amount  the call was accepted and both balances held, at 1000 and 0
  ✗ sep41-transfer-self  the holder's balance moved from 1000 to 1001; debiting and crediting the same address must net zero, so a change means one side was applied without the other
  ✗ sep41-transfer-negative-amount  a transfer of -1 succeeded; the holder gained, consistent with the contract reading it as a transfer in the opposite direction — anyone can withdraw from anyone
  ✗ sep41-transfer-over-balance  balance() returned -1, which is negative; the premise cannot be established

9 pass, 3 fail, 0 skipped, 4 unverifiable, 0 not implemented (16 checks)
exit 1
```

This is the run that makes the others mean something. Sixteen passes
against a SAC prove only that the guard does not cry wolf on a contract
that is correct by construction; a check that never fires looks exactly
like a check that fires correctly, until something deserves a red mark.

Four points worth drawing out:

- **`over-balance`'s red mark here is collateral, not a floor test.** Its
  message says so — "the premise cannot be established". `negative-amount`
  ran first and left the recipient at `-1`, so over-balance's
  recipient-premise read met unsound accounting before it could attempt
  `balance + 1`. The floor is genuinely untested in *this* run. Against a
  token whose only flaw is the missing floor it fires properly, which is
  what the check's own unit tests cover; against this fixture the honest
  reading is that two flaws were demonstrated and a third was pre-empted by
  one of them. The ordering already minimises this — reverse it and three
  checks are pre-empted instead of one — but a contract with several
  arithmetic holes cannot have all of them tested in a single run, and the
  report saying "premise cannot be established" rather than claiming a
  floor failure is the tool behaving correctly.
- **`transfer-self` was not a planted flaw.** The fixture was written with
  three deliberate bugs and this was not among them — `transfer` reads both
  balances into locals before writing either, so when `from == to` the
  second write clobbers the first. The guard found it, and described it
  more precisely than the fixture's own comment did.
- **`zero-amount` passes on the same broken code path**, because zero nets
  zero even through that aliasing. That is exactly why the two invariance
  checks are separate rather than one.
- **The verdict is a mix, not a wall of red.** Nine passes, three failures,
  four unverifiable. A tool that failed everything against a broken
  contract would prove only that it disliked the contract.

The negative amount was also confirmed independently of the guard, by
invoking the contract directly — transaction
`b24e690d38dcc9844967cba898170e26f8c62caf20f8e3bc9aca739cccb1a6a5`, which
moved the holder from `1000` to `1100` and the recipient from `0` to
`-100`. The transfer ran backwards: the holder's signature withdrew from
the recipient. That is ground truth for the check that asserts it.

### Why a broken contract reports four unverifiable rows

Once `over-balance` is ignored, the holder's balance is negative, and the
contract's accounting is unsound for everything after it. Those checks
report UNVERIFIABLE with the reason — not FAIL — because the defect has
already been named once and repeating it would bury the finding among its
own consequences. See `soundness` on `Sep41Context`.

This is also why the refusal checks run least-destructive first
(`zero → self → negative-amount → over-balance`): ordered the other way,
the same contract reports one failure and eight unverifiable rows, and two
real defects go untested. Pinned by unit test in `suite.test.ts`.
