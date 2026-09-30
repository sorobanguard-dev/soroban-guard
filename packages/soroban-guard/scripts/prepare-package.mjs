// Stage the repository README and LICENSE into this package before packing.
//
// Both live at the repository root, one level above the published package,
// so without this the npm page would have no README and the tarball no
// licence text. The README's links are made absolute on the way, since
// npmjs.com resolves relative ones against the package, not the repository
// (see readme-links.ts, which is imported as TypeScript: prepack runs from
// the repository, where Node strips types).
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { absoluteLinks } from "./readme-links.ts";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));
const REPO = "https://github.com/sorobanguard-dev/soroban-guard/blob/main/";

const { text, changed } = absoluteLinks(
	readFileSync(`${root}README.md`, "utf8"),
	REPO,
);

writeFileSync(`${pkg}README.md`, text);
copyFileSync(`${root}LICENSE`, `${pkg}LICENSE`);

console.log(`staged README.md (${changed} links made absolute) and LICENSE`);
