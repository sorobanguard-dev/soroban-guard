# vulnerable-token

A deliberately non-conformant SEP-41 token, for proving that the guard's
negative checks actually fire.

> **This contract loses funds by design.** Every omission in it is
> deliberate. It is published nowhere, deployed only to testnet, and is not
> a template for anything. If you are looking for a SEP-41 reference
> implementation, use the [Stellar Asset Contract][sac] or the
> [token example][ex] — not this.

[sac]: https://developers.stellar.org/docs/tokens/stellar-asset-contract
[ex]: https://github.com/stellar/soroban-examples/tree/main/token

## Why it exists

A conformance checker that has only ever run against correct contracts has
proved one thing: it does not cry wolf. It has not proved it catches
anything, because a check that silently never fires looks exactly like a
check that fires correctly, as long as every contract under test is
correct.

Sixteen passes against a Stellar Asset Contract cannot close that gap. A
SAC is protocol-native and shared by every classic asset — it cannot be
non-conformant in an interesting way. The tokens that can are the ones
someone wrote in Rust. This is one of those, written to be wrong in
specific, named ways.

## The flaws

**[`src/lib.rs`](src/lib.rs) is the source of truth** — its module doc
tables each flaw against the check that targets it, next to the code that
implements it. Duplicating that table here is how the two drifted apart
once already (a sign error replicated into three files before a live run
caught it), so this file describes what the flaws *mean for a run* and
leaves the mechanism there.

What matters when reading a result: the table says which check **targets**
which flaw, not which will produce a verdict on any given run. A contract
with several arithmetic holes cannot have all of them tested at once — the
first flaw that goes unrefused leaves the accounting unsound, and later
checks report "the premise cannot be established" rather than testing
their own rule. On the logged run `negative-amount` fires first and leaves
the recipient at `-1`, so `over-balance` reports a premise failure and the
floor is never actually exercised. That is the tool being honest, not a
gap — but it means a red mark against this fixture should be read for
*which* message it carries, not merely counted.

Authorization is *correct* throughout — `require_auth` is called on every
path that needs it. The holes are arithmetic, which is the realistic shape:
the signature checks out and the call still moves value that never existed.
An open-mint fixture would be caught by anything and prove nothing.

Some things are deliberately left conformant, so a run produces a mix
rather than a wall of red:

- the five reads return sane values, so the interface checks pass;
- `transfer_from` checks and decrements its allowance honestly, so
  `sep41-transfer_from-unauthorized` passes and the missing expiry is its
  only defect — though in a full run `sep41-transfer_from-expired` usually
  reports UNVERIFIABLE rather than FAIL, because `transfer`'s flaws fire
  first and leave the accounting unsound before it gets its turn. Its
  coverage is the unit tests;
- a zero-amount transfer genuinely nets zero, so
  `sep41-transfer-zero-amount` passes.

### Known-latent holes, deliberately left open

Beyond the four tabled flaws, this contract has arithmetic holes that **no
guard path can reach**, because every check sends a positive constant on
these routes. They are recorded so the next reader recognises them as known
rather than rediscovering them as findings:

- `burn(-x)` mints instead of burning;
- `mint(-x)` reduces a balance, though it is admin-only;
- `approve(-x)` stores a negative allowance, which later spends then refuse
  — visible but benign;
- `transfer_from` permits self-aliasing and overdraft, the same shapes
  `transfer` exhibits deliberately;
- `burn` and `burn_from` accept a positive amount above the holder's
  balance, driving it negative — the burn counterpart of the tabled
  over-balance flaw, which `sep41-transfer-over-balance` targets on
  `transfer` alone.

A *negative amount* on the delegated paths is the one exception: it is
guarded, because `allowance < amount` is false for negatives and a spender
with no grant would otherwise debit a third party. That one is closed even
though it is equally unreachable, since it is an authorization bypass
rather than arithmetic and the fixture should not ship one.

A tool that failed every check against this contract would prove only that
it disliked the contract.

### The third flaw was not planted

`transfer-self` was found, not designed. `transfer` loads `from` and `to`
into separate locals and then writes both; when they are the same address
the second write overwrites the first, so a self-transfer nets the *amount*
rather than zero: the debit is written and then clobbered by the credit.
The guard probes with `+1`, and the holder ends one unit richer
(`1000 → 1001` in the log). The guard reported it as "debiting and
crediting the same address must net zero, so a change means one side was
applied without the other" — a better description than the fixture's own
comment had.

It is kept rather than fixed. An unintended defect that a check catches is
stronger evidence than a planted one.

## Building

Use `stellar contract build`, **not** `cargo build`. The SDK's build script
refuses a plain cargo invocation:

```sh
stellar contract build
# → target/wasm32v1-none/release/vulnerable_token.wasm
```

Two traps, both of which produce confusing errors:

- **Target.** soroban-sdk 28 requires `wasm32v1-none`. Building for
  `wasm32-unknown-unknown` on Rust 1.82+ fails with a message about
  `reference-types` and `multi-value` — the target is not supported, and
  the fix is the newer target, not an older Rust.
- **Toolchain shadowing.** If `rustc` resolves to a Homebrew install rather
  than rustup's, the wasm target will be missing even though
  `rustup target list --installed` shows it, and you get
  `can't find crate for 'core'`. Check with `which -a rustc`; prepend
  `~/.cargo/bin` to `PATH` if Homebrew's comes first.

## Deploying and running the guard against it

Three funded testnet identities, named here by the role each plays. Create
them if you have none — `--fund` uses Friendbot, and the passphrase has to
be explicit because `--network testnet` alone does not resolve it:

```sh
RPC=https://soroban-testnet.stellar.org
PASS="Test SDF Network ; September 2015"

for role in vuln-admin vuln-owner vuln-spender; do
  stellar keys generate "$role"
  curl -s "https://friendbot.stellar.org/?addr=$(stellar keys address $role)" \
    -o /dev/null
done
```

Deploy and give the holder something to spend. The admin is bound by the
contract's constructor, so it is set atomically with deployment — there is
no window in which someone else could claim it:

```sh
CONTRACT=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/vulnerable_token.wasm \
  --source-account vuln-admin --rpc-url "$RPC" --network-passphrase "$PASS" \
  -- --admin "$(stellar keys address vuln-admin)" \
  --decimals 7 --name "Vulnerable Test Token" --symbol VULN)

stellar contract invoke --id "$CONTRACT" --source-account vuln-admin \
  --rpc-url "$RPC" --network-passphrase "$PASS" \
  -- mint --to "$(stellar keys address vuln-owner)" --amount 1000
```

Then run the guard:

```sh
# Relative to this directory — the commands above run from
# fixtures/vulnerable-token, where the CLI's path is two levels up.
OWNER_SECRET=$(stellar keys secret vuln-owner) \
SPENDER_SECRET=$(stellar keys secret vuln-spender) \
  node ../../packages/soroban-guard/src/cli.ts "$CONTRACT"
```

Expect roughly `9 pass, 2 fail, 5 unverifiable` and exit 1: the
self-transfer and the negative amount fail, and the checks after them
report UNVERIFIABLE because the negative amount left the recipient below
zero. The exact counts move with the spender's history and with which flaw
fires first.

**Deploy a fresh instance per run.** The unrefused negative amount leaves
the *recipient* at `-1` — the contract reads the sign as a direction and
debits the party that authorized nothing. A second run against the same
instance starts from that unsound state, so checks that read the recipient
report UNVERIFIABLE instead of testing their own rule, and the run says
less than a fresh one would.

**Use a fresh spender** for the same reason the real fixture does:
`transfer_from-unauthorized` tests the *absence* of an allowance, and any
prior `approve` destroys that premise permanently for that pair.

## Notes

- `Cargo.lock` is committed. This is a deployable artifact, not a library,
  and a fixture that silently changes behaviour on a dependency bump is
  worse than useless.
- `target/` is gitignored — rebuild rather than commit binaries.
- Nothing here is part of the published `soroban-guard` package. It lives
  outside `packages/` so an install can never carry it.
