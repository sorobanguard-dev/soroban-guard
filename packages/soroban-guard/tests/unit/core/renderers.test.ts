import { describe, expect, it } from "vitest";
import {
	padVisible,
	style,
	supportsColor,
	visibleWidth,
} from "../../../src/core/ansi.ts";
import { renderJsonReport } from "../../../src/core/json-report.ts";
import { renderMarkdownReport } from "../../../src/core/md-report.ts";
import { renderPretty } from "../../../src/core/pretty.ts";
import { exitCodeFor, publicRpcUrl } from "../../../src/core/report.ts";
import type { CheckResult, CheckStatus } from "../../../src/core/types.ts";

/**
 * Offline coverage for the three report formats and the colour helpers.
 *
 * These render evidence a reviewer reads instead of running the tool, so a
 * silent formatting regression is worse here than in most code: the
 * document would still look plausible while stating something the run never
 * found. What the assertions pin is therefore the *claims* — the headline
 * verdict, the exit code, the schema — rather than the decoration around
 * them.
 */

const CONTRACT = "CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM";
const RAN_AT = "2026-09-24T00:00:00.000Z";
const RPC = "https://soroban-testnet.stellar.org";

function result(
	status: CheckStatus,
	overrides: Partial<CheckResult> = {},
): CheckResult {
	return {
		id: "sep41-transfer",
		clause: "SEP-41 §transfer",
		layer: "behavior",
		requirement: "required",
		status,
		expected: "transfer moves the amount from holder to recipient",
		actual: "holder -1, recipient +1",
		evidence: {},
		durationMs: 1,
		...overrides,
	};
}

function common(results: readonly CheckResult[]) {
	return {
		standard: "SEP-41",
		contractId: CONTRACT,
		results,
		ranAt: RAN_AT,
		rpcUrl: RPC,
	};
}

describe("ansi", () => {
	it("wraps in an escape only when enabled", () => {
		expect(style("x", "green", true)).toBe("\u001B[32mx\u001B[0m");
		expect(style("x", "green", false)).toBe("x");
	});

	// The staircase bug: padEnd counts the escape bytes, so a coloured cell
	// pads about ten columns short and every later column drifts.
	it("measures and pads printable width, not byte length", () => {
		const coloured = style("abc", "red", true);
		expect(coloured.length).toBeGreaterThan(3);
		expect(visibleWidth(coloured)).toBe(3);
		expect(visibleWidth(padVisible(coloured, 8))).toBe(8);
	});

	it("leaves an already-wide string alone rather than truncating", () => {
		expect(padVisible("abcdef", 3)).toBe("abcdef");
	});

	// A redirected report must stay greppable, so colour is opt-in on
	// evidence the stream is a terminal.
	it("gives colour only to a TTY that reports support", async () => {
		expect(supportsColor({ isTTY: true, hasColors: () => true })).toBe(true);
		expect(supportsColor({ isTTY: true, hasColors: () => false })).toBe(false);
		expect(supportsColor({ isTTY: false, hasColors: () => true })).toBe(false);
		expect(supportsColor({})).toBe(false);
	});

	// NO_COLOR present means off, even empty — that is the standard, and
	// `NO_COLOR= command` is the common way to set it.
	it("honours NO_COLOR even when empty", async () => {
		const previous = process.env.NO_COLOR;
		try {
			process.env.NO_COLOR = "1";
			expect(supportsColor({ isTTY: true, hasColors: () => true })).toBe(false);
			process.env.NO_COLOR = "";
			expect(supportsColor({ isTTY: true, hasColors: () => true })).toBe(false);
		} finally {
			if (previous === undefined) {
				delete process.env.NO_COLOR;
			} else {
				process.env.NO_COLOR = previous;
			}
		}
	});
});

describe("renderJsonReport", () => {
	it("round-trips and pins the schema", () => {
		const parsed = JSON.parse(renderJsonReport(common([result("PASS")])));
		expect(parsed.schema).toBe("soroban-guard/report@1");
		expect(parsed.contractId).toBe(CONTRACT);
		expect(parsed.ranAt).toBe(RAN_AT);
		expect(parsed.results).toHaveLength(1);
		expect(parsed.results[0].clause).toBe("SEP-41 §transfer");
	});

	it("counts each status separately", () => {
		const parsed = JSON.parse(
			renderJsonReport(
				common([
					result("PASS"),
					result("FAIL", { id: "a" }),
					result("UNVERIFIABLE", { id: "b" }),
					result("SKIPPED", { id: "c" }),
					result("NOT_IMPLEMENTED", { id: "d" }),
				]),
			),
		);
		expect(parsed.summary).toEqual({
			total: 5,
			pass: 1,
			fail: 1,
			unverifiable: 1,
			skipped: 1,
			notImplemented: 1,
		});
	});

	// The browser has no process to read an exit status from, so the field is
	// the only way a consumer learns the verdict. It must be the same answer
	// the CLI exits with, never a recomputation that could drift.
	it("embeds exactly the exit code the CLI would use", () => {
		for (const results of [
			[result("PASS")],
			[result("FAIL")],
			[result("UNVERIFIABLE")],
			[],
		]) {
			const parsed = JSON.parse(renderJsonReport(common(results)));
			expect(parsed.exitCode).toBe(exitCodeFor(results));
		}
	});
});

describe("renderMarkdownReport", () => {
	it("states the contract, network and run time", () => {
		const doc = renderMarkdownReport(common([result("PASS")]));
		expect(doc).toContain(`| Contract | \`${CONTRACT}\` |`);
		expect(doc).toContain(`| Run at | ${RAN_AT} |`);
		expect(doc).toContain(RPC);
	});

	it("groups by layer and marks a FAIL so it cannot be skimmed past", () => {
		const doc = renderMarkdownReport(
			common([
				result("PASS", { id: "sep41-name", layer: "interface" }),
				result("FAIL", { id: "sep41-burn" }),
			]),
		);
		expect(doc).toContain("## Layer: interface (1/1 pass)");
		expect(doc).toContain("## Layer: behavior (0/1 pass)");
		expect(doc).toContain("**FAIL**");
		// An empty layer prints no heading rather than an empty table.
		expect(doc).not.toContain("## Layer: events");
	});

	it("renders evidence a reader can chase", () => {
		const doc = renderMarkdownReport(
			common([
				result("FAIL", {
					evidence: {
						before: { holder: "100" },
						after: { holder: "100" },
						txHash: "abc123",
						ledger: 4738627,
						error: "HostError: Error(Contract, #4)",
					},
				}),
			]),
		);
		expect(doc).toContain("tx: `abc123`");
		expect(doc).toContain("ledger: 4738627");
		expect(doc).toContain('before: `{"holder":"100"}`');
		expect(doc).toContain("Error(Contract, #4)");
	});

	// A backtick inside a single-backtick span closes it early and the rest
	// renders as prose, swallowing the evidence around it. Diagnostics come
	// from the SDK, so their content is not ours to assume about.
	it("fences evidence so a backtick cannot break out of its code span", () => {
		const doc = renderMarkdownReport(
			common([
				result("FAIL", { evidence: { error: "saw `transfer` in the trace" } }),
			]),
		);
		expect(doc).toContain("``saw `transfer` in the trace``");
	});

	// A pipe would split the cell and silently move every column after it.
	it("escapes a pipe inside a cell", () => {
		const doc = renderMarkdownReport(
			common([result("FAIL", { actual: "a | b" })]),
		);
		expect(doc).toContain("a \\| b");
	});

	// Diagnostics are unbounded, and the old implementation spread every
	// backtick run into Math.max — past V8's argument limit the report
	// itself threw instead of rendering.
	it("fences a hostile run of backticks without throwing", () => {
		const doc = renderMarkdownReport(
			common([result("FAIL", { evidence: { error: "`".repeat(200000) } })]),
		);
		// The fence has to be longer than the run it encloses, or the span
		// closes early and the rest of the row escapes into prose.
		expect(doc).toContain("`".repeat(200001));
		// And the payload has to survive. Asserting the fence alone would
		// pass a renderer that emitted the fence and dropped what it was
		// meant to enclose — the fence is 200001 backticks, so a document
		// containing only it satisfies a 200001-run assertion by itself.
		// Fence + payload + fence is at least 600002 of them.
		const backticks = (doc.match(/`/g) ?? []).length;
		expect(backticks).toBeGreaterThanOrEqual(600002);
	});

	describe("headline", () => {
		// The whole point of the sentence: it must not read as a score when a
		// required member went unexercised.
		it("refuses to claim conformance when coverage is incomplete", () => {
			const doc = renderMarkdownReport(
				common([
					result("PASS", { id: "a" }),
					result("UNVERIFIABLE", { id: "b" }),
				]),
			);
			expect(doc).toContain("This is not a conformance claim");
			expect(doc).toContain("Exit code 2");
			expect(doc).not.toContain("Conformant —");
		});

		it("claims conformance only when every check held", () => {
			const doc = renderMarkdownReport(common([result("PASS")]));
			expect(doc).toContain(
				"Conformant — all 1 checks were exercised and held",
			);
			expect(doc).toContain("Exit code 0");
		});

		// Exit 0 with nothing exercised: `optional` members the contract does
		// not declare. Conformant, but "all 0 checks were exercised and held"
		// would claim a run that asked nothing had answered something.
		it("does not claim checks were exercised when none were", () => {
			const doc = renderMarkdownReport(
				common([result("NOT_IMPLEMENTED", { requirement: "optional" })]),
			);
			expect(doc).toContain("no check was exercised either");
			expect(doc).toContain("Exit code 0");
			expect(doc).not.toContain("were exercised and held");
		});

		it("names a violation and a missing required member", () => {
			expect(renderMarkdownReport(common([result("FAIL")]))).toContain(
				"Violation found — 1 violated",
			);
			expect(
				renderMarkdownReport(common([result("NOT_IMPLEMENTED")])),
			).toContain("1 required member not implemented");
		});

		it("says nothing ran rather than claiming conformance", () => {
			const doc = renderMarkdownReport(common([]));
			expect(doc).toContain("No checks ran");
			// Every headline names its exit code, this one included — a reader
			// comparing two reports should not have to know which outcome is
			// the exception.
			expect(doc).toContain(`Exit code ${exitCodeFor([])}`);
		});

		/**
		 * The agreement that matters. The headline is phrased from
		 * `exitCodeFor`'s answer rather than re-deriving it, and this walks
		 * every status combination to prove the document and the process
		 * cannot tell a reader different things.
		 */
		it("always names the exit code exitCodeFor returns", () => {
			const statuses: readonly CheckStatus[] = [
				"PASS",
				"FAIL",
				"UNVERIFIABLE",
				"SKIPPED",
				"NOT_IMPLEMENTED",
			];
			for (const first of statuses) {
				for (const second of statuses) {
					for (const requirement of ["required", "optional"] as const) {
						const results = [
							result(first, { id: "a" }),
							result(second, { id: "b", requirement }),
						];
						const doc = renderMarkdownReport(common(results));
						expect(doc).toContain(`Exit code ${exitCodeFor(results)}`);
					}
				}
			}
		});
	});
});

describe("renderPretty", () => {
	const pretty = (results: readonly CheckResult[], color = false) =>
		renderPretty({
			standard: "SEP-41",
			contractId: CONTRACT,
			results,
			color,
			width: 100,
		});

	it("groups by layer with a per-layer tally", () => {
		const out = pretty([
			result("PASS", { id: "sep41-name", layer: "interface" }),
			result("FAIL", { id: "sep41-burn" }),
		]);
		expect(out).toContain("interface (1/1)");
		expect(out).toContain("behavior (0/1)");
		expect(out).not.toContain("events");
	});

	it("aligns ids into one column across layers", () => {
		const out = pretty([
			result("PASS", { id: "short", layer: "interface" }),
			result("PASS", { id: "a-much-longer-check-id" }),
		]);
		// Both rows put their prose at the same column, so the verdicts and
		// messages line up even though the groups print separately.
		const columns = out
			.split("\n")
			.filter((line) => line.includes("holder -1"))
			.map((line) => line.indexOf("holder -1"));
		expect(columns).toHaveLength(2);
		expect(columns[0]).toBe(columns[1]);
	});

	// A hash or base64 blob has no space to break at, so it must be cut
	// rather than allowed to run past the terminal and wrap at column zero.
	it("keeps an unbreakable token inside the width", () => {
		const out = pretty([result("UNVERIFIABLE", { actual: "X".repeat(140) })]);
		for (const line of out.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
		// Preservation, not just width: every character survives chunking.
		// Whitespace-stripped, so line breaks rejoin and only the lowercase
		// x in "expected:" sits outside the run.
		expect(out.replace(/\s/g, "")).toContain("X".repeat(140));
	});

	// Without Unicode-aware splitting, a chunk boundary can land between
	// an emoji's surrogate halves and corrupt the diagnostic on display.
	// Width is UTF-16 units throughout, so sixty emoji (120 units) must
	// wrap even though they are sixty code points.
	it("never splits a surrogate pair across lines", () => {
		const out = pretty([
			result("UNVERIFIABLE", { actual: `diagnostic: ${"😀".repeat(60)}` }),
		]);
		expect(out).not.toContain("\uFFFD");
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
		expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
		// Count, not just intactness: dropped tail chunks would also leave
		// no surrogates behind.
		expect((out.match(/😀/gu) ?? []).length).toBe(60);
		for (const line of out.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
	});

	it("wraps long prose inside the given width", () => {
		const out = pretty([
			result("UNVERIFIABLE", {
				actual: "word ".repeat(60).trim(),
			}),
		]);
		for (const line of out.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
	});

	it("explains only what failed to hold", () => {
		expect(pretty([result("PASS")])).not.toContain("expected:");
		expect(pretty([result("FAIL")])).toContain("expected:");
	});

	it("emits no escape byte when colour is off", () => {
		expect(pretty([result("FAIL")])).not.toContain("\u001B");
		expect(pretty([result("FAIL")], true)).toContain("\u001B");
	});

	it("leads with the verdict, not the arithmetic", () => {
		expect(pretty([result("FAIL")])).toContain("1 violation found");
		expect(pretty([result("FAIL"), result("FAIL", { id: "b" })])).toContain(
			"2 violations found",
		);
		expect(pretty([result("UNVERIFIABLE")])).toContain(
			"no violation found, 1 unassessed",
		);
		expect(pretty([result("PASS")])).toContain("conformant");
	});

	/**
	 * The two cases a FAIL/unassessed count cannot see: a required member
	 * the contract does not implement exits 1, and a run that assessed
	 * nothing exits 2 — neither may print the green word.
	 */
	it("never prints conformant unless the exit code is 0", () => {
		expect(pretty([result("NOT_IMPLEMENTED")])).toContain(
			"1 required member missing",
		);
		expect(pretty([result("NOT_IMPLEMENTED")])).not.toContain("conformant");
		expect(pretty([])).toContain("no checks ran");
		expect(pretty([])).not.toContain("conformant");
	});

	/**
	 * Exit 0 does not imply anything was exercised. A suite of `optional`
	 * members the contract does not declare is conformant — optionality
	 * excuses absence — but the word over "0/1 checks held" would read as a
	 * pass for a run that asked no questions.
	 */
	it("does not call a run conformant when nothing was exercised", () => {
		const absent = [result("NOT_IMPLEMENTED", { requirement: "optional" })];
		expect(exitCodeFor(absent)).toBe(0);
		expect(pretty(absent)).toContain("nothing exercised");
		expect(pretty(absent)).not.toContain("conformant");
		// One real PASS alongside, and the word is earned again.
		expect(pretty([...absent, result("PASS", { id: "b" })])).toContain(
			"conformant",
		);
	});

	it("agrees with the exit code on every status combination", () => {
		const statuses: readonly CheckStatus[] = [
			"PASS",
			"FAIL",
			"UNVERIFIABLE",
			"SKIPPED",
			"NOT_IMPLEMENTED",
		];
		for (const first of statuses) {
			for (const second of statuses) {
				for (const requirement of ["required", "optional"] as const) {
					const results = [
						result(first, { id: "a" }),
						result(second, { id: "b", requirement }),
					];
					const out = pretty(results);
					const code = exitCodeFor(results);
					if (code === 0) {
						expect(out).toContain("conformant");
					} else if (code === 1) {
						expect(out).not.toContain("conformant");
						expect(out).toContain("found");
						expect(out).not.toContain("no violation found");
					} else {
						expect(out).toContain("no violation found");
						expect(out).not.toContain("conformant");
					}
				}
			}
		}
	});
});

describe("publicRpcUrl", () => {
	it("keeps a clean endpoint untouched", () => {
		expect(publicRpcUrl("https://soroban-testnet.stellar.org")).toBe(
			"https://soroban-testnet.stellar.org",
		);
	});

	it("redacts path, query and userinfo rather than reproducing them", () => {
		for (const raw of [
			"https://key123@soroban-testnet.stellar.org",
			"https://soroban-testnet.stellar.org/api/key123",
			"https://soroban-testnet.stellar.org?api_key=key123",
			"https://user:pass@soroban-testnet.stellar.org/v1?key=key123",
		]) {
			expect(publicRpcUrl(raw)).toBe("https://soroban-testnet.stellar.org/…");
		}
	});

	it("names an unparseable value instead of echoing it", () => {
		expect(publicRpcUrl("not a url")).toBe("<unparseable>");
	});
});
