# Contributing

## Setup

Requirements: Node 24, pnpm 12 (`corepack` or standalone — the repo pins
`pnpm@12.3.4` via `packageManager` + `devEngines`). The Node 24 floor is
functional, not fashion: the bin executes TS sources directly via type
stripping, so the runtime must support it.

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

## Conventions

* TypeScript strict + `verbatimModuleSyntax` (`import type` where due) +
  `erasableSyntaxOnly` (the bin executes TS sources directly via Node
  type stripping — only erasable syntax allowed).
* `core/` never imports `sep41/`. Checks return `FAIL`, never throw, for
  bad contracts; only harness failures (RPC down, bad address) throw.
* Commits: whole files, one concern per message (`feat:`/`fix:`/`chore:`/
  `test:`/`docs:`). Green tree per commit: typecheck + Biome + unit.
* Tests live next to logic: unit under `tests/unit/` mirroring `src/`,
  live under `tests/live/` skip-guarded on env. No network in unit tests.
* Never commit secrets. `.env` is gitignored; `.env.example` is the
  template and must stay sourceable.

## Pull requests

Small, one concern, green CI. Describe the behavior change and how it was
verified (offline tests + live output where applicable).

## Release

Bump the version in both manifests together (`package.json`,
`packages/soroban-guard/package.json`) —
a release that moves one and not the other repeats the 0.2.0/0.4.1 drift.
Then CHANGELOG entry, merge, tag `vX.Y.Z`, push tag.
