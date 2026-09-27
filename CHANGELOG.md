# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[SemVer](https://semver.org/). Pre-1.0: anything may change.

Conventions: new entries go under `[Unreleased]` in the order Breaking,
Added, Changed, Fixed, Removed. A released section is immutable — correct a
released claim by adding an entry to `[Unreleased]`, never by rewriting
history someone may already have read. Reference issues as
`([#12](https://github.com/birserg/soroban-guard/issues/12))` and credit
outside contributors by handle. Entries describe what changed for a user of
the tool; internal refactors with no observable effect belong in the commit
log, not here.

## [Unreleased]

### Breaking

- The CLI is invoked as `soroban-guard`, matching the package name. The
  `sep41-guard` script name and usage string from 0.1.0 are gone.

### Added

- Five negative checks, four on `transfer` and one on `transfer_from`.

  Three require a refusal: moving more than the holder's balance (allowing
  it mints or wraps, letting a holder spend value never issued), a negative
  amount (`i128` is signed, and reading one as a reversed transfer lets
  anyone withdraw from anyone), and spending a grant whose
  `live_until_ledger` has passed (a contract that stores the amount and
  drops the deadline leaves every approval it ever made permanent). The
  last has to create the expiry it tests, because `allowance()` reports the
  amount but never the ledger it dies at.

  Two assert arithmetic instead, because SEP-41 permits either answer: a
  zero-amount transfer and a self-transfer must leave the balances where
  they started, whether the contract accepts or refuses them — only a
  balance that moved is a finding.
- `--format text|md|json`. `md` emits a clause-mapped conformance report for
  committing or review; `json` carries `schema`, `exitCode` and a per-status
  summary for CI and the web UI.
- Grouped, colour-coded terminal output when stdout is a TTY: checks are
  grouped by layer, ids aligned, long diagnostics wrapped to the terminal
  width. Honours `NO_COLOR`, and a piped or redirected run gets the plain
  report so output stays greppable. `--no-color` forces plain.

### Changed

- A balance or allowance that answers with something impossible now FAILs
  the contract wherever it is read, not only where a read check reads it.
  Previously the two no-op checks reported UNVERIFIABLE when their
  after-read came back defective — a negative quantity, a non-`i128`, or an
  unexplained trap — which handed one contract two verdicts for the same
  response, since `sep41-balance` FAILs it. Worse, a negative reading is
  recorded as the run's first, so the old behaviour set that flag, muted
  every later check, and exited 2 for a contract that had minted.

  A merely *unreadable* answer — none arriving, an archived entry, an
  asset's own trustline policy — is unchanged and still UNVERIFIABLE: that
  is a fact about the run rather than about the contract. The distinction
  is now stated in `docs/check-reference.md` under the premise rules.
- A contract whose accounting goes negative is reported once, not once per
  check. A token that lets the holder overdraw leaves the balance below
  zero, and every later check used to meet that same defect while
  establishing its own premise — so one missing bounds check reported as
  nine failures, with the real finding buried among its own consequences.
  The first negative reading is still a FAIL; the rest now report
  UNVERIFIABLE and say why they cannot measure anything.

  Taken alone, against a deliberately broken token, this turns
  `7 pass, 9 fail` into `7 pass, 1 fail, 8 unverifiable` for identical
  input — a run that gates on failure counts will see the number move.
  Combined with the reordering below, the same token now reports
  `9 pass, 2 fail, 5 unverifiable`.
- The four checks between the unauthorized spend and the writes run
  least-destructive first —
  `zero-amount`, `self`, `negative-amount`, `over-balance` — which changes
  nothing against a conformant token and much against a broken one. A
  check whose attempt is *ignored* moves what it offered: zero moves zero
  whatever the implementation does, a self-transfer should net zero but is
  not guaranteed to — a contract that reads both balances before writing
  either nets the amount instead — a negative amount shifts one unit, and
  `balance + 1` takes everything and leaves the
  accounting unsound. Ordered the old way, a broken token reported one
  defect and eight unverifiable rows; ordered this way the same token
  reports two, because the first unrefused flaw destroys the premises the
  later checks need whatever the order. Pinned by unit test, because the
  reasoning is invisible to anyone reshuffling the list.

### Fixed

- The `md` and `json` reports record the RPC endpoint's origin only. A
  hosted provider's API key lives in the path or query string, and those
  reports are made to be committed or carried through CI, so anything after
  the origin is redacted rather than reproduced.

## [0.2.0] — 2026-09-19

Checks that change state: every state-changing SEP-41 member is verified by
performing it against testnet — `transfer`, `approve`, `transfer_from`,
`burn`, `burn_from` — plus a negative check proving an allowance-less
`transfer_from` is refused. Ledger evidence (transaction hashes) is logged
in `docs/verification.md`.

### Added

- Write checks for the five state-changing members. Each reads the before
  state, submits a signed call of one unit, reads again, and asserts:
  exact deltas for `transfer`, `transfer_from`, `burn`, `burn_from`;
  exact replacement (not accumulation) for `approve`, which the spec says
  overrides any existing allowance. Reports carry the before/after values
  with transaction hash and ledger as evidence.
- `transfer_from-unauthorized` negative check. Submits a spend with no
  allowance and passes only when the contract refuses; runs before
  `approve` so the grant cannot destroy the premise it tests.
- `OWNER_SECRET` / `SPENDER_SECRET`. A secret settles its own address; one
  that disagrees with a supplied `*_ADDRESS` exits rather than guessing
  which was meant. Runs holding no key report writes UNVERIFIABLE.
- Write consent gate. A run holding a secret exits before touching the
  network unless the passphrase is a test network (or
  `--allow-non-testnet-write` is given) and the RPC endpoint does not
  contradict it. Funding is check-first, so a funded mainnet account would
  otherwise reach a real transfer with nothing in the way. Recipient
  control is enforced per check instead: a generated `SPENDER_ADDRESS` has
  a key this process discards at exit, so any check that would move a unit
  to it reports UNVERIFIABLE.

### Changed

- Reads are one file per SEP-41 member, so an unassessed member is visible
  in the directory listing rather than only at runtime.
- Each account is defined once, carrying its address, signing authority and
  whether it was generated for the run.

### Fixed

- Several situations that reported a conformant contract as FAIL, each
  found against a real token on testnet: a holder or recipient that is the
  asset issuer (transfers there mint or burn rather than move), a transfer
  refused by the asset's own trustline or authorization policy, an address
  holding no trustline, and a self-transfer. All now report UNVERIFIABLE.
- A submission that never reached the ledger — RPC unreachable, an unfunded
  signer, a stale sequence — was reported as the contract refusing. It now
  propagates and the run records SKIPPED.
- `name` and `symbol` no longer FAIL an empty value. SEP-41 constrains them
  to `String` and no further, so the anomaly is reported rather than
  accused.

## [0.1.0] — 2026-09-11

First runnable slice: five SEP-41 read checks against testnet.

### Added

- `decimals`, `balance`, `allowance`, `name`, `symbol` checks with
  PASS/FAIL/SKIPPED/UNVERIFIABLE/NOT_IMPLEMENTED verdicts and evidence.
- Contract-spec introspection: real NOT_IMPLEMENTED for WASM tokens,
  graceful fallback for SACs.
- `sep41-guard` CLI with tri-state exit codes (0 conformant / 1 violation /
  2 unknown) and a terminal report with per-status and per-layer summary.
- Tier-0 Friendbot funding with retry verification.
- Offline unit suite (fixtures, stub-server checks) + env-gated live tests.
- CI: typecheck + Biome + unit on every push, pinned actions.
- Project docs: SECURITY.md, CONTRIBUTING.md, Code of Conduct, issue
  templates, Dependabot.

### Fixed

- The WASM-fetch fallback test supplied no code hash, so it returned
  `native` before reaching the 404 branch it covers. It now exercises that
  branch and asserts the fetch happened.
