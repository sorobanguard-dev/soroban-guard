# Contributing

There are four ways in, and each has a path:

* **A bug** — open an issue from the *Bug report* template. Search the
  open issues first; a duplicate with a better reproduction is still
  welcome, as a comment on the original.
* **A new check** — open an issue from the *New check proposal* template
  and wait for a reply before writing code. A check is a claim about
  every token it runs against, so its spec clause and its false-positive
  story are agreed before the implementation.
* **A fix or small change** — a pull request is enough; a typo or an
  obvious bug needs no issue first. See [Pull requests](#pull-requests).
* **A vulnerability** — never a public issue. Report it privately, as
  [SECURITY.md](SECURITY.md) describes.

New to open source? [First Contributions](https://github.com/firstcontributions/first-contributions)
walks through fork, branch and pull request.

## Setup

Requirements: Node 24, pnpm 12 (`corepack enable`, or pnpm standalone —
the repo pins `pnpm@12.3.4` via `packageManager` + `devEngines`). Use
pnpm for every script: `npm run …` refuses with `EBADDEVENGINES`, by
design, so the lockfile has one owner. The Node 24 floor is
functional, not fashion: from a clone, `node packages/soroban-guard/src/cli.ts`
runs the TS sources directly via type stripping. The published package
runs compiled `dist/` instead — Node does not strip types inside
`node_modules` — which `prepack` builds.

```sh
cp .env.example .env  # fill in contract + probe addresses (testnet only)
pnpm install
```

## Checks

```sh
pnpm typecheck          # strict tsc, all packages
pnpm check:ci           # Biome lint + format verification (read-only)
pnpm test               # offline unit tests — always green, no network
pnpm test:live          # testnet live tests — needs `.env` sourced
```

`pnpm check` (without `:ci`) rewrites files via Biome — run it before
committing, then re-verify with `check:ci`.

The layers, and what each one proves:

| Layer | Where | Proves |
|---|---|---|
| Unit | `packages/*/tests/unit/`, `packages/web/tests/` | the logic, against stubbed RPC |
| CLI | `packages/soroban-guard/tests/unit/cli.test.ts` | the real `cli.ts` process: arguments, keys, consent, exit codes |
| Live | `packages/soroban-guard/tests/live/`, `*.live.test.ts` | the checks against real testnet contracts |
| Package | CI `package` job | the packed tarball installs and its CLI runs from `node_modules` |
| Browser | by hand, with Varial (formerly Freighter) | the web checker's DOM wiring |

CI also runs a changed-test gate: a pull request from outside the
maintainers that changes `packages/*/src/` or `packages/*/scripts/`
without changing anything under `packages/*/tests/` fails until it does.

## Conventions

* TypeScript strict + `verbatimModuleSyntax` (`import type` where due) +
  `erasableSyntaxOnly` (sources run directly under Node type stripping
  from a clone — only erasable syntax allowed).
* `core/` never imports `sep41/`. Checks return `FAIL`, never throw, for
  bad contracts; only harness failures (RPC down, bad address) throw.
* Commits: whole files, one concern per message (`feat:`/`fix:`/`chore:`/
  `test:`/`docs:`). Green tree per commit: typecheck + Biome + unit.
* Logic ships with its tests, in the same commit — a follow-up "add
  tests" commit is not accepted. A test must fail when the behavior it
  names is removed; check that by breaking the code once before relying
  on it. In `packages/soroban-guard`, unit tests go under `tests/unit/`
  mirroring `src/`, live ones under `tests/live/` skip-guarded on env;
  in `packages/web`, under `tests/`. No network in unit tests.
* Page scripts that touch the DOM on import cannot be tested directly.
  Put the decision in a module with no DOM access (`owed.ts`, `run.ts`)
  and keep the page script to wiring.
* Never commit secrets. `.env` is gitignored; `.env.example` is the
  template and must stay sourceable.

## Pull requests

Small, one concern, green CI. Fill in the template: describe the
behavior change, link the issue it addresses (`Fixes #123`) when there is
one, and say how it was verified (offline tests + live output where
applicable). Changes to the web checker also say what was clicked
through in a browser with Varial: the page script's DOM wiring has
no unit tests, only the DOM-free modules it calls do.

CodeRabbit reviews every pull request. Address each of its comments
before asking for a merge — fix it, or reply with the reason it does not
apply. An unanswered comment is an open review, whoever wrote it.

## Signed Testnet smoke

Run **signed testnet** from the Actions tab to exercise the packed CLI
with real writes. Each run funds its own issuer, holder, and spender via
Friendbot and deploys a fresh Stellar Asset Contract. The holder starts
with a token balance and the spender starts with zero allowance. The job
uses generated Testnet keys in memory and needs no repository secrets.

The job expects all SEP-41 checks to pass. Download the artifact for
`report/report.json` and `run.log` if a check fails. If setup fails before
the CLI starts, the log identifies the step that failed.

## Release

1. Bump `package.json`, `packages/soroban-guard/package.json`, and
   `packages/web/package.json` together. Add a dated entry to `CHANGELOG.md`
   and merge the release PR. Wait for CI on the merged commit.
2. Run the **release** workflow manually on `main` and confirm the run uses
   the release commit. The packaging job installs and smoke-tests the CLI
   on Node 24, then uploads the tarball and shows its SHA-512 integrity in
   the run summary. A manual run has no publishing permissions and works
   for versions already on npm.
3. Install the tarball in a scratch directory. Run it against a real Testnet
   token three times with both keys and save each JSON report separately.
   Run sequentially when reusing accounts. Check that the spender starts
   each run with zero allowance and that the three verdict sets agree check
   by check before tagging. For a fresh asset and accounts, run the
   **signed testnet** workflow three times on the same release commit.
4. Tag that same commit `vX.Y.Z` and push the tag. The workflow checks that
   the tag matches the version and points to a commit on `main`, then runs
   packaging again. The publish job downloads that run's tested tarball
   and checks its integrity before uploading to npm. It checks npm's
   integrity value before publishing the GitHub release. A draft on the
   tag supplies the release notes. Otherwise GitHub generates them.

Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
for `sorobanguard-dev/soroban-guard` with the workflow filename
`release.yml` and permission to run `npm publish`. The publish job checks
that npm is at least 11.5.1 before uploading a new version.

If publishing fails, rerun the failed job to reuse the tested artifact. The
workflow accepts an existing npm version when its integrity matches and
leaves an already-published GitHub release as it is. For a manual publish,
use the tested tarball from outside the workspace:

```sh
cd /tmp
npm publish /path/to/soroban-guard-X.Y.Z.tgz --ignore-scripts --access public
```

After publishing, confirm `npm view soroban-guard dist-tags.latest` and run
`npx --yes soroban-guard@X.Y.Z --version` from outside the workspace. The
website's `/changelog` page is built from `CHANGELOG.md` on deploy.
