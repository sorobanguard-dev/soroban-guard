// Stage the repository README and LICENSE into this package before packing.
//
// Both live at the repository root, one level above the published package,
// so without this the npm page would have no README and the tarball no
// licence text. The README's relative links (`docs/check-reference.md`,
// `CONTRIBUTING.md`, …) resolve against the package on npmjs.com, not the
// repository, so they are rewritten to absolute GitHub URLs here — the
// root file itself keeps its relative links for readers on GitHub.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));
const REPO = "https://github.com/sorobanguard-dev/soroban-guard/blob/main/";

const readme = readFileSync(`${root}README.md`, "utf8");

// A markdown link target that is neither absolute, an in-page anchor, nor
// a mailto: — i.e. a path into the repository.
const rewritten = readme.replace(
	/\]\((?!https?:|#|mailto:)(?:\.\/)?([^)\s]+)\)/g,
	(_match, path) => `](${REPO}${path})`,
);

writeFileSync(`${pkg}README.md`, rewritten);
copyFileSync(`${root}LICENSE`, `${pkg}LICENSE`);

const changed = (readme.match(/\]\((?!https?:|#|mailto:)/g) ?? []).length;
console.log(`staged README.md (${changed} links made absolute) and LICENSE`);
