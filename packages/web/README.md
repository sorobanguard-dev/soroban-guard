# @soroban-guard/web

The public site: pages that explain the tool, and a checker that runs **the
same sixteen checks as the CLI** in the browser, signed by the visitor's own
Freighter wallet.

> **The element ids in `components/Checker.astro` are a contract.**
> `scripts/checker.ts` looks fourteen of them up by name and throws at
> startup if one is missing, so renaming an id there breaks the page.
> Scope them to their component: `getElementById` returns the *first*
> match, and two components that both called a container `rows` once meant
> a live run would have wiped the recorded report and appended list items
> into a div.

## Why Astro, and why static

There is no backend, and adding one would make the product worse. The checks
talk to Soroban RPC directly and sign through a wallet extension the visitor
controls, so a server could only sit in the way — holding keys it should not
hold, or proxying calls it cannot improve.

That leaves one real architectural question: the Stellar SDK is 674 kB, and it
has to load before a single check runs. Astro ships **zero JavaScript by
default**, so the page is pre-rendered HTML a crawler reads without executing
anything — but that alone does not keep the SDK out of the first paint. A
static `import` inside an Astro `<script>` is bundled eagerly and served in a
module tag, which is how this package shipped 674 kB to every visitor while its
README claimed otherwise.

`Checker.astro` therefore pulls the module in with a **dynamic** `import()`, on
whichever comes first: the checker scrolling into view, or someone reaching for
a control inside it. Someone who reads the page and never runs a check pays
nothing for the SDK.

```
src/pages/index.astro     → the explanation, the recorded report, try-it,
                            verdicts and scope
src/pages/run.astro       → the browser checker
src/pages/checks.astro    → docs/check-reference.md, parsed at build time
src/pages/changelog.astro → CHANGELOG.md, parsed at build time
src/layouts/Base.astro    → metadata, canonical URL, icons, JSON-LD
src/data/                 → build-time data: the recorded run, the parsers
                            for the two Markdown files, the demo token
src/scripts/              → the browser logic (freighter, run, checker); the
                            SDK enters here and nowhere else
```

## What is not re-implemented here

Nothing about conformance. `runSuite`, the checks, `exitCodeFor`,
`STATUS_GLYPH` and both report renderers are imported from `soroban-guard`.
This package supplies a `Signer` backed by Freighter instead of one backed by
an environment variable, and renders results as HTML instead of ANSI.

```
CLI:  KeypairSigner(secret from env)  ─┐
                                       ├─→ Sep41Context → runSuite → results
Web:  freighterSigner(wallet)         ─┘
```

The glyphs come from `STATUS_GLYPH` rather than a copy — a second table drifts,
and this one already had, printing an em dash for `SKIPPED` where the CLI
prints `○`.

## What a visitor should expect

- **A full run signs real transactions** and moves real testnet units. `burn`
  and `burn_from` destroy one unit each, irreversibly.
- **Several approval prompts**, one per write.
- **On the demo token, all sixteen run from one wallet.** The demo token
  (`src/data/demo.ts`) is `fixtures/vulnerable-token` built with a public
  faucet; "Get 5 test VULN" gives the wallet what a full run spends, and with
  the counterparty field empty the page generates, funds and signs for a
  second account. Its key lives only in the tab — what it receives is faucet
  VULN, so nothing of value is stranded.
- **On any other token, four checks stay UNVERIFIABLE** unless the visitor
  names a counterparty and runs the CLI with both keys. The page never
  sends someone's real tokens to an account nobody can recover: without a
  counterparty it uses a keyless generated address, which the suite's
  throwaway guards refuse to pay.

## Commands

```sh
pnpm --filter @soroban-guard/web dev        # localhost:4321
pnpm --filter @soroban-guard/web build      # static bundle into dist/
pnpm --filter @soroban-guard/web preview    # serve the built bundle
pnpm --filter @soroban-guard/web test       # offline: parsers, wallet, wording
SOROBAN_GUARD_LIVE=1 pnpm --filter @soroban-guard/web test tests/demo.live.test.ts
                                            # a new visitor's full run on testnet
pnpm --filter @soroban-guard/web typecheck
```

## Deploying

`dist/` is a plain static bundle — no server, no API. With Cloudflare Pages:

| Setting | Value |
| ------- | ----- |
| Production branch | `main` |
| Root directory | *(empty — the repository root)* |
| Build command | `corepack enable && corepack prepare pnpm@12.3.4 --activate && pnpm install --frozen-lockfile && pnpm --filter @soroban-guard/web build` |
| Output directory | `packages/web/dist` |
| `NODE_VERSION` | `24` (also read from `.nvmrc`) |
| `SKIP_DEPENDENCY_INSTALL` | `true` |

`SKIP_DEPENDENCY_INSTALL` stops Cloudflare running its own `pnpm install`
first with whatever pnpm its build image carries; the build command installs
with the exact pnpm the repository pins, against the frozen lockfile. The
site imports the CLI's TypeScript sources directly, so nothing else needs
building first.

Change `site` in `astro.config.mjs` to the real domain before deploying: the
canonical URL, the Open Graph tags and `robots.txt` all derive from it.

## Two toolchain notes

**Biome skips `.astro` files** (`biome.json` → `files.includes`). It parses
their frontmatter but not their template, so every variable the template
renders is reported as unused. Those are false positives; `tsc` checks the
real logic in `src/scripts/`. For the same reason **no page carries an inline
script**: each `<script>` in a component only imports a module from
`src/scripts/`, where Biome and `tsc` both see it.

**Typecheck is `astro sync && tsc`, not `astro check`.** `astro check` does not
support TypeScript 7, which this workspace uses. `astro sync` generates the
ambient types, and `tsc` does the checking.
