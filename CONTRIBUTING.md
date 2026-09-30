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
| Browser | by hand, with Freighter | the web checker's DOM wiring |

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
through in a browser with Freighter: the page script's DOM wiring has
no unit tests, only the DOM-free modules it calls do.

CodeRabbit reviews every pull request. Address each of its comments
before asking for a merge — fix it, or reply with the reason it does not
apply. An unanswered comment is an open review, whoever wrote it.

## Release

Bump the version in the manifests together (`package.json`,
`packages/soroban-guard/package.json`, and `packages/web/package.json`,
which has matched since 0.4.1) — a release that moves one and not the
other repeats the 0.2.0/0.4.1 drift. Then CHANGELOG entry, merge, tag
`vX.Y.Z`, push tag, and publish from the package directory:

```sh
cd packages/soroban-guard && npm publish   # prepack builds dist/
```

The website's `/changelog` page is built from `CHANGELOG.md`, so it
shows the release on the next deploy with nothing else to update.
