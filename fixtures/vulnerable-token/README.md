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

| Flaw | Check that targets it |
| ---- | --------------------- |
| `transfer` never compares the amount against the balance | `sep41-transfer-over-balance` |
| `transfer` never rejects a negative amount | `sep41-transfer-negative-amount` |
| `transfer` reads both balances before writing either | `sep41-transfer-self` |
| `approve` discards `live_until_ledger` | `sep41-transfer_from-expired` |

The mapping is which check *targets* which flaw, not which will produce a
verdict on any given run. A contract with several arithmetic holes cannot
have all of them tested at once: the first flaw that goes unrefused leaves
the accounting unsound, and later checks report "the premise cannot be
established" rather than testing their own rule. On the logged run
`negative-amount` fires first and leaves the recipient at `-1`, so
`over-balance` reports a premise failure and the floor is never actually
exercised. That is the tool being honest, not a gap — but it means a red
mark against this fixture should be read for *which* message it carries,
not merely counted.

Authorization is *correct* throughout — `require_auth` is called on every
path that needs it. The holes are arithmetic, which is the realistic shape:
the signature checks out and the call still moves value that never existed.
An open-mint fixture would be caught by anything and prove nothing.

Some things are deliberately left conformant, so a run produces a mix
rather than a wall of red:

- the five reads return sane values, so the interface checks pass;
- `transfer_from` checks and decrements its allowance honestly, so
  `sep41-transfer_from-unauthorized` passes and only the missing expiry
  fails;
- a zero-amount transfer genuinely nets zero, so
  `sep41-transfer-zero-amount` passes.

A tool that failed every check against this contract would prove only that
it disliked the contract.

### The third flaw was not planted

`transfer-self` was found, not designed. `transfer` loads `from` and `to`
into separate locals and then writes both; when they are the same address
the second write overwrites the first, so a self-transfer of `-1` leaves
the holder one unit *richer*. The guard reported it as "debiting and
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

Needs a funded testnet identity. Substitute your own aliases for `sf`
(admin) and `alice` (the holder the guard will use).

```sh
RPC=https://soroban-testnet.stellar.org
PASS="Test SDF Network ; September 2015"

CONTRACT=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/vulnerable_token.wasm \
  --source-account sf --rpc-url "$RPC" --network-passphrase "$PASS")

stellar contract invoke --id "$CONTRACT" --source-account sf \
  --rpc-url "$RPC" --network-passphrase "$PASS" \
  -- initialize --admin "$(stellar keys address sf)" \
  --decimals 7 --name "Vulnerable Test Token" --symbol VULN

stellar contract invoke --id "$CONTRACT" --source-account sf \
  --rpc-url "$RPC" --network-passphrase "$PASS" \
  -- mint --to "$(stellar keys address alice)" --amount 1000
```

Then run the guard:

```sh
OWNER_SECRET=$(stellar keys secret alice) \
SPENDER_SECRET=$(stellar keys secret <a-fresh-spender>) \
  node packages/soroban-guard/src/cli.ts "$CONTRACT"
```

Expect roughly `9 pass, 3 fail, 4 unverifiable` and exit 1. The exact
counts move with the spender's history; the three failures should not.

**Deploy a fresh instance per run.** The first `over-balance` failure
leaves the holder's balance negative, and a second run against the same
instance starts from unsound state — every later check reports
UNVERIFIABLE rather than testing its own rule.

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
