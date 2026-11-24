# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[SemVer](https://semver.org/). Pre-1.0: anything may change.

Conventions: new entries go under `[Unreleased]` in the order Breaking,
Added, Changed, Fixed, Removed. A released section is immutable — correct a
released claim by adding an entry to `[Unreleased]`, never by rewriting
history someone may already have read. Reference issues as
`([#12](https://github.com/sorobanguard-dev/soroban-guard/issues/12))` and credit
outside contributors by handle. Entries describe what changed for a user of
the tool; internal refactors with no observable effect belong in the commit
log, not here.

## [Unreleased]

### Added

- `fundAccountInLedger`, which funds an account as `fundAccount` does and
  resolves to the ledger the funding landed in. It resolves to `undefined`
  when the account already existed, so nothing was funded, and when the
  RPC's account entry does not say which ledger last changed it.
  `fundAccount` is unchanged.

### Changed

- `ContractCode`'s `native` arm has a required `stellarAsset` field: true
  when the contract's executable is a Stellar Asset Contract, false for
  code whose spec cannot be read. Code that builds a `native` value must
  set it.

### Fixed

- Read checks and write balance/allowance premises report FAIL when a
  wrong return type cannot be decoded by Stellar SDK 17.4, rather than
  treating it as a harness failure. Decoder failures on the expected
  type remain unknown, and RPC failures still report SKIPPED.
- Read checks and write balance/allowance premises check the returned
  Stellar type, not only its value. A wrong type that decodes to the same
  value used to PASS: an `i32` from `decimals`, a `Symbol` from `name` or
  `symbol`, a `u64` from `balance` or `allowance`. Each is now a FAIL.
- A contract whose code is referenced through CAP-85 no longer stops the
  run when its contract spec cannot be read (no spec section, or since SDK
  17.3 more than one). It falls back to attempting every member, as
  contracts with directly deployed code already did.
- RPC requests time out after 30 seconds, in the CLI and the browser, and
  writes now use that same bounded connection. An RPC that never answered
  used to hold a run indefinitely.
- A failed call counts as the contract refusing only when the
  simulation's diagnostic events show the contract's own code refused it
  (see the check reference). Other failures, such as the host running out
  of budget, used to count as refusals, so a negative check could PASS on
  them and a read or a valid transfer could FAIL. They now give no
  verdict: a read reports UNVERIFIABLE and a write SKIPPED. An RPC or
  wallet error that happened to mention `HostError` is now a harness
  failure rather than a refusal. An RPC that simulates without diagnostic
  events can attribute no refusal, and the evidence then says so.
- A Stellar Asset Contract's own policy, such as a missing trustline, is
  recognised again on the current testnet RPC, which gives the reason only
  in a simulation's diagnostic events. A read of a holder with no
  trustline reported FAIL instead of UNVERIFIABLE, and a negative check
  could credit the asset's trustline policy as the contract refusing.
  Simulation diagnostics now appear in error evidence.
- Once sent, a transaction can apply, fail on the ledger, expire unapplied,
  or remain unresolved. An unresolved write reports UNVERIFIABLE with its
  hash. Contract writes have a 180-second validity window. A send
  answered with `DUPLICATE` used to count as refused, and a lost send
  request reported SKIPPED without its hash. Both are now followed as
  sent, since either may still apply. A receipt settles either; a
  `DUPLICATE` send cannot be proven expired, since nothing says from
  which ledger the network may have had it. A write is sent only as
  it was prepared: a signer that returns a different transaction is
  refused before anything is sent. A send the network declines names the
  result code it came back with, such as `ERROR: txInsufficientFee`.
- To establish expiry, the checker reads consecutive ledgers through the
  first close after the deadline. It verifies each result set against the
  ledger header's `txSetResultHash`. Missing or inconsistent ledger
  data leaves the outcome unresolved, and so does a result the checker
  cannot identify, which could be the transaction; a receipt in a later
  ledger still settles it. A result names a transaction by its own hash
  whatever code failed it. Each status check resumes from the first
  unverified ledger, even when its lookup by hash fails.
- Every read, and every write's simulation, must describe state from the
  latest ledger a transaction of the run settled in: its funding, a
  trustline, or a write, including one that failed on the ledger. Servers
  behind one RPC URL can answer from a backend that has not reached that
  ledger, with state from before the transaction, so a transfer read back
  there could look as if it moved nothing and FAIL. Such an answer is
  asked again for up to 20 seconds, and so is a request asked again that
  fails in that time; a first request that fails is not retried. A stale
  answer is then refused: a read reports UNVERIFIABLE with the reason,
  and a write SKIPPED without sending. A write also takes its signer's
  sequence number from that ledger, and every new simulation of it starts
  from the envelope as first built. `sep41-transfer_from-expired` reads and
  simulates from the ledger its wait observed, and credits a refusal only
  when one ledger shows it refused with the holder funded and the
  recipient's balance readable.
- After a token operation's outcome is unknown, the suite skips its later
  writes, setup approvals included. The check it belonged to reports
  UNVERIFIABLE with its hash, and each later write check reports SKIPPED
  with the same hash instead of measuring balances that transaction can
  still change. Previously the next check went ahead and could PASS on
  uncertain state.
- In the browser, a transaction the page sent that may still land and
  move the wallet's balance holds back every action that could collide
  with it: a run, a new faucet claim, and the cleanup's send-back. Each
  kind has its own lookup: "Check transaction status" for the cleanup,
  "Check the faucet claim" for a claim, and "Check the last run's
  transaction" for a run's write left unresolved with nothing to send
  back. The hold ends when a lookup finds the transaction landed, failed
  or expired, or the RPC reports a ledger closed after its deadline.
  Every token read and write the page makes describes state from the
  latest ledger by which a transaction it knows of may have moved the
  wallet's balance. The cleanup keeps the temporary account's key and sends nothing again
  until it knows whether the first transfer applied; a cleanup whose
  balance read comes back stale stays retryable with the same key. A new
  run discards the key, and the page warns first that it will.
- In the browser, nothing is sent back for native XLM, or for a Stellar
  Asset Contract whose underlying asset cannot be identified; that asset's
  `name()` is read from the run's ledger floor. A contract counts as a
  Stellar Asset Contract by its executable, so a WASM token whose spec
  cannot be read remains eligible for cleanup.
- In the browser, a temporary second account that could not be set up is
  no longer used by the checks. They get a fresh address nothing has
  touched, since a funding or trustline transaction that may still land
  could change that account between the checks that name it. A trustline
  that cannot be confirmed is reported as possibly applying, with its
  hash, where it used to be reported as not landed.

### Removed

- `isContractOutcome`, exported since 0.4.5, which judged whether an error
  was a contract refusal from its message text. Message text is not
  evidence of a refusal, so nothing replaces it.

## [0.4.5] — 2026-10-19

### Added

- `--format json` reports record the version that produced them, as
  `toolVersion`. The field is new; nothing existing changed, so the schema
  stays `report@1`.

### Fixed

- `sep41-transfer_from-expired` gives its test grant six ledgers instead
  of two. Two was too tight for testnet: the grant could expire before it
  landed or before it was read back, so the check sometimes reported
  UNVERIFIABLE on a conformant token. Keyed runs take about 20 seconds
  longer.

## [0.4.4] — 2026-10-19

### Fixed

- `sep41-transfer-zero-amount` and `sep41-transfer-self` no longer report
  the transaction fee as a contract defect. On native XLM the holder also
  pays the fee out of the balance being measured, and both checks read
  that drop as the contract moving value: through 0.4.3 they FAILed native
  XLM for it. They now report UNVERIFIABLE there, as `transfer` and
  `transfer_from` already did since 0.4.1. The exemption stays narrow: a
  fee only lowers the account that paid it, so a holder whose balance
  rose, a recipient that moved, or the same drop on any other token still
  FAILs. Found by running the suite against Stellar's own asset contracts
  for the results page.

## [0.4.3] — 2026-10-12

### Changed

- Wider npm keywords (`token`, `smart-contract`, `audit`, `ci`) so the
  package surfaces for what it is, plus an npm version badge in the README.

## [0.4.2] — 2026-10-01

### Added

- `sep41-transfer_from-expired` evidence records the grant it confirmed
  before the wait, as `granted`, beside the allowance read after it. A
  refusal was always tested against a grant that had landed; the report now
  shows it, so an expired grant cannot be mistaken for one that never
  existed. ([#4](https://github.com/sorobanguard-dev/soroban-guard/pull/4))

### Changed

- The CHECKS.md footer no longer says a verdict is reproducible by re-running
  against the same contract. Writes move balances and allowances, so a later
  run is a fresh check of the contract as it then stands, not a replay; the
  footer now says so. ([#4](https://github.com/sorobanguard-dev/soroban-guard/pull/4))

## [0.4.1] — 2026-09-29

### Fixed

- Same-asset transaction fees no longer read as contract defects. When the
  token under test is the asset fees are paid in (the native XLM contract),
  the fee-paying side's delta is reported UNVERIFIABLE instead of FAIL;
  genuine mismatches elsewhere in the pair still fail as before.
- `burn` and `burn_from` refusals on the native asset name the gate: the
  Stellar Asset Contract deliberately declines burning XLM, which is a
  known property rather than a defect — the FAIL verdict stands, since
  SEP-41 declares no exemption.

## [0.4.0] — 2026-09-29

Checks that assert what a contract must *refuse* or leave alone, and the
first evidence that they fire. Six negative checks join the ten member
checks, and `fixtures/vulnerable-token` — a SEP-41 token written to be
wrong in named ways — exists so their failure can be demonstrated rather
than assumed: against it the suite reports two defects with specific
diagnoses while still passing the nine checks it should.

Numbered 0.4.0 rather than 0.3.0 because `v0.3.0` was tagged at the report
renderers and never carried a version bump or a changelog section. That tag
is published, so it stays where it is; the Breaking entry below belongs to
that work and is recorded here because it was recorded nowhere else.

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
