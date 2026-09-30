import { describe, expect, it } from "vitest";
import { absoluteLinks } from "../../scripts/readme-links.ts";

/**
 * The published README: npmjs.com resolves a relative link against the
 * package, where `docs/` and `CONTRIBUTING.md` do not exist, so every
 * repository path must point at GitHub and nothing else may move.
 */
const REPO = "https://github.com/o/r/blob/main/";

describe("absoluteLinks", () => {
	it("points repository paths at GitHub", () => {
		expect(absoluteLinks("[ref](docs/check-reference.md)", REPO)).toEqual({
			text: `[ref](${REPO}docs/check-reference.md)`,
			changed: 1,
		});
	});

	it("drops a leading ./", () => {
		expect(absoluteLinks("[c](./CONTRIBUTING.md)", REPO).text).toBe(
			`[c](${REPO}CONTRIBUTING.md)`,
		);
	});

	it("rewrites image sources too", () => {
		expect(absoluteLinks("![logo](assets/logo.png)", REPO).text).toBe(
			`![logo](${REPO}assets/logo.png)`,
		);
	});

	it("leaves absolute, anchor and mailto links alone", () => {
		const readme =
			"[a](https://x.dev) [b](http://x.dev) [c](#usage) [d](mailto:a@b.c)";
		expect(absoluteLinks(readme, REPO)).toEqual({ text: readme, changed: 0 });
	});

	it("counts every rewrite in a document", () => {
		const readme = "[a](one.md) and [b](two.md#part) and [c](#local)";
		const { text, changed } = absoluteLinks(readme, REPO);
		expect(changed).toBe(2);
		expect(text).toBe(
			`[a](${REPO}one.md) and [b](${REPO}two.md#part) and [c](#local)`,
		);
	});
});
