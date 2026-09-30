import { describe, expect, it } from "vitest";
import {
	latestRelease,
	parseChangelog,
	RELEASES,
} from "../src/data/changelog.ts";
import {
	CHECK_REFERENCE,
	parseCheckReference,
} from "../src/data/check-reference.ts";
import { type Block, blocks, inline } from "../src/data/markdown.ts";
import { RECORDED_RUN } from "../src/data/recorded-run.ts";

/**
 * The /changelog and /checks pages are built from the repository's own
 * Markdown. These pin the parse against the real files, so an edit to
 * either that the parser cannot read fails here rather than shipping a
 * page with a missing release or raw asterisks.
 */

function allHtml(list: readonly Block[]): string[] {
	return list.flatMap((block) =>
		block.kind === "p" ? [block.html] : block.items.flat(),
	);
}

describe("inline", () => {
	it("renders code, bold, emphasis and links", () => {
		expect(
			inline(
				"**must** refuse *before* `x` — see [SEP-41](https://example.org/sep)",
			),
		).toBe(
			'<strong>must</strong> refuse <em>before</em> <code>x</code> — see <a href="https://example.org/sep" rel="noopener">SEP-41</a>',
		);
	});

	it("leaves asterisks inside code alone", () => {
		expect(inline("set `*_ADDRESS` and `i128::MAX`")).toBe(
			"set <code>*_ADDRESS</code> and <code>i128::MAX</code>",
		);
	});

	it("escapes HTML, so a doc cannot inject markup", () => {
		expect(inline("a <b> & `<c>`")).toBe(
			"a &lt;b&gt; &amp; <code>&lt;c&gt;</code>",
		);
	});

	it("shows check ids without the standard prefix", () => {
		expect(inline("`sep41-transfer-self`")).toBe("<code>transfer-self</code>");
	});

	// The changelog names the 0.1.0 command; it must read as it was.
	it("keeps a prefix that is not a check id", () => {
		expect(inline("`sep41-guard`")).toBe("<code>sep41-guard</code>");
	});

	it("does not read arithmetic as emphasis", () => {
		expect(inline("balance + 1 and 2 * 3 * 4")).toBe(
			"balance + 1 and 2 * 3 * 4",
		);
	});
});

describe("blocks", () => {
	it("keeps a list item's indented second paragraph inside the item", () => {
		const result = blocks(
			"- First line\n  wrapped.\n\n  Second para.\n- Next\n\nAfter.",
		);
		expect(result).toEqual([
			{
				kind: "ul",
				items: [["First line wrapped.", "Second para."], ["Next"]],
			},
			{ kind: "p", html: "After." },
		]);
	});
});

describe("CHANGELOG.md", () => {
	it("yields every tagged release, newest first", () => {
		expect(RELEASES.map((r) => r.version)).toEqual([
			"0.4.1",
			"0.4.0",
			"0.2.0",
			"0.1.0",
		]);
	});

	it("dates every release", () => {
		for (const release of RELEASES) {
			expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	it("leaves no Markdown syntax unrendered", () => {
		for (const release of RELEASES) {
			expectFullyRendered([
				...allHtml(release.summary),
				...release.sections.flatMap((s) => allHtml(s.blocks)),
			]);
		}
	});

	// Latent until the next entry lands in [Unreleased], which is exactly
	// when it would have shipped wrong.
	it("never calls an unreleased section the latest release", () => {
		const releases = parseChangelog(
			"# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A thing.\n\n## [0.4.1] — 2026-09-29\n\n### Fixed\n\n- Another.\n",
		);
		expect(releases.map((r) => r.version)).toEqual(["Unreleased", "0.4.1"]);
		expect(latestRelease(releases)?.version).toBe("0.4.1");
	});

	it("leaves out an empty unreleased section", () => {
		const releases = parseChangelog(
			"# Changelog\n\n## [Unreleased]\n\n## [0.4.1] — 2026-09-29\n\n### Fixed\n\n- Another.\n",
		);
		expect(releases.map((r) => r.version)).toEqual(["0.4.1"]);
	});
});

/**
 * Markdown the renderer does not handle — tables, `*` or numbered lists,
 * images, stray headings — would otherwise pass through as literal text
 * with every other test green. Anything that looks like leftover syntax in
 * the output fails here, so the parser stays closed to what it can render.
 */
function expectFullyRendered(html: readonly string[]): void {
	for (const fragment of html) {
		// Code is shown as written — `--format text|md|json` is a real pipe.
		const prose = fragment.replace(/<code>[^<]*<\/code>/g, "");
		expect(prose).not.toMatch(
			/\*\*|(^|\s)\*\S|`|\]\(|\||^\s*(\d+\.|\*|#{1,6})\s/,
		);
	}
}

describe("check-reference.md", () => {
	const checks = CHECK_REFERENCE.groups.flatMap((group) => group.checks);

	it("describes all sixteen checks, each once", () => {
		expect(checks).toHaveLength(16);
		expect(new Set(checks.map((c) => c.id)).size).toBe(16);
	});

	// The report and the reference must name the same checks, or a row's
	// link to its entry would lead nowhere.
	it("covers exactly the checks the report prints", () => {
		expect(new Set(checks.map((c) => c.id))).toEqual(
			new Set(RECORDED_RUN.map((row) => row.id)),
		);
	});

	it("groups them as reads and writes", () => {
		expect(CHECK_REFERENCE.groups.map((g) => g.title)).toEqual([
			"Reads",
			"Writes",
		]);
	});

	it("gives every check a body", () => {
		for (const check of checks) {
			expect(check.body.length).toBeGreaterThan(0);
		}
	});

	it("leaves no Markdown syntax unrendered", () => {
		expectFullyRendered([
			...allHtml(CHECK_REFERENCE.method),
			...CHECK_REFERENCE.groups.flatMap((group) => [
				...allHtml(group.intro),
				...group.checks.flatMap((check) => allHtml(check.body)),
			]),
		]);
	});

	it("refuses to drop a section it does not know", () => {
		expect(() =>
			parseCheckReference(
				"# Checks reference\n\nIntro.\n\n## Premises\n\nProse only.\n",
			),
		).toThrow(/Premises/);
	});

	it("drops the verdicts section by name", () => {
		expect(
			parseCheckReference("# Checks reference\n\n## Verdicts\n\n- `PASS`\n")
				.groups,
		).toEqual([]);
	});
});
