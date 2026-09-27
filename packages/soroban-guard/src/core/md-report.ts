/**
 * The CHECKS.md emitter: the same results `renderReport` prints, shaped for
 * a reviewer reading on GitHub rather than an operator reading a terminal.
 *
 * Two audiences, two renderers, one data source. The terminal report is
 * scanned live and optimizes for narrowness; this one is committed,
 * diffed and linked, so it states the clause for every row and spells out
 * what each verdict means. Neither derives numbers the other invented —
 * both are pure functions over the same `CheckResult[]`, so they cannot
 * disagree about what happened.
 */
import { exitCodeFor } from "./report.ts";
import {
	type CheckResult,
	type CheckStatus,
	countByStatus,
	LAYER_ORDER,
} from "./types.ts";

export interface MarkdownReportInput {
	readonly standard: string;
	readonly contractId: string;
	readonly results: readonly CheckResult[];
	/**
	 * When the run happened, ISO-8601. Passed in rather than read from the
	 * clock so the renderer stays pure and its output is reproducible in a
	 * test.
	 */
	readonly ranAt: string;
	/** RPC endpoint the run observed, so a reader can reproduce it. */
	readonly rpcUrl: string;
}

/**
 * What each verdict licenses a reader to conclude. Spelled out in the
 * document because the distinction between "violated" and "not shown" is
 * the whole point of the tool, and a reviewer meeting the table for the
 * first time has no way to infer it.
 */
const STATUS_MEANING: Record<CheckStatus, string> = {
	PASS: "the clause was exercised and held",
	FAIL: "the clause was exercised and was violated",
	UNVERIFIABLE: "the clause could not be exercised; no verdict either way",
	SKIPPED: "the check could not run (harness or network failure)",
	NOT_IMPLEMENTED: "the contract does not declare this member",
};

const BADGE: Record<CheckStatus, string> = {
	PASS: "PASS",
	FAIL: "**FAIL**",
	UNVERIFIABLE: "UNVERIFIABLE",
	SKIPPED: "SKIPPED",
	NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
};

/** Markdown table cells cannot hold a raw pipe or newline. */
function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Wrap a value in a code span that survives whatever the value contains.
 *
 * A backtick inside a single-backtick span closes it early, and the rest of
 * the line renders as prose — so a diagnostic quoting a contract's own
 * source could silently swallow the evidence around it. CommonMark's rule
 * is that a span may be opened with any number of backticks and is closed
 * by the same number, so this counts the longest run inside and uses one
 * more. Diagnostics come from the SDK, so their content is not ours to
 * assume about.
 */
function code(text: string): string {
	// Incremental, not spread: diagnostics are unbounded and V8 caps
	// argument lists, so a huge diagnostic would throw out of Math.max
	// instead of producing a report.
	let longest = 0;
	for (const match of text.matchAll(/`+/g)) {
		longest = Math.max(longest, match[0].length);
	}
	const fence = "`".repeat(longest + 1);
	// A span whose content starts or ends with a backtick needs padding
	// spaces, which CommonMark strips back off when rendering.
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * The headline sentence, phrased from `exitCodeFor`'s own answer.
 *
 * It asks `exitCodeFor` rather than re-deriving the outcome from statuses.
 * An earlier draft reimplemented the rule here and claimed agreement in a
 * comment — but two copies of a rule cannot be made to agree by asserting
 * that they do, only by being one copy. Whichever way the exit code moves,
 * this sentence moves with it.
 *
 * Deliberately not a score. A count like "10 of 11 passed" reads as a near
 * pass and invites a reader to cite the contract as conformant when a
 * required member was never exercised — the same overclaim every check
 * avoids by reporting UNVERIFIABLE instead of guessing. The arithmetic
 * still follows the verdict, so it is available without being mistaken for
 * the conclusion.
 */
function summarize(results: readonly CheckResult[]): string {
	if (results.length === 0) {
		// Names its exit code like the other three. A reader comparing two
		// reports should not have to know that one outcome is the exception.
		return "No checks ran — nothing was assessed. Exit code 2.";
	}
	const total = results.length;
	switch (exitCodeFor(results)) {
		case 1: {
			const failed = countByStatus(results, "FAIL");
			const missingRequired = results.filter(
				(result) =>
					result.status === "NOT_IMPLEMENTED" &&
					result.requirement === "required",
			).length;
			const reasons = [
				failed > 0 ? `${failed} violated` : null,
				missingRequired > 0
					? `${missingRequired} required member not implemented`
					: null,
			].filter((part) => part !== null);
			return `Violation found — ${reasons.join(", ")} of ${total} checks. Exit code 1.`;
		}
		case 2: {
			const unassessed =
				countByStatus(results, "UNVERIFIABLE") +
				countByStatus(results, "SKIPPED");
			return `No violation found, but coverage is incomplete — ${unassessed} of ${total} checks could not be assessed. This is not a conformance claim. Exit code 2.`;
		}
		default: {
			// Exit 0 does not imply anything was exercised. A suite of
			// `optional` members the contract does not declare is conformant
			// — optionality excuses absence — but nothing was tested, and
			// "all 0 checks held" would read as a clean bill of health for a
			// run that asked no questions.
			const passed = countByStatus(results, "PASS");
			if (passed === 0) {
				return `Conformant — no required clause was violated, but no check was exercised either. Exit code 0.`;
			}
			return `Conformant — all ${passed} checks were exercised and held. Exit code 0.`;
		}
	}
}

/**
 * Evidence rendered as an indented list under a row that needs
 * justification. A PASS states its numbers too: a reviewer checking the
 * tool's own honesty needs the before/after that produced the verdict, not
 * just the claim that it passed.
 */
function evidenceLines(result: CheckResult): readonly string[] {
	const { evidence } = result;
	const parts: string[] = [];
	if (evidence.before !== undefined) {
		parts.push(`before: ${code(JSON.stringify(evidence.before))}`);
	}
	if (evidence.after !== undefined) {
		parts.push(`after: ${code(JSON.stringify(evidence.after))}`);
	}
	if (evidence.txHash !== undefined && evidence.txHash !== "") {
		parts.push(`tx: ${code(evidence.txHash)}`);
	}
	if (evidence.ledger !== undefined) {
		parts.push(`ledger: ${evidence.ledger}`);
	}
	if (evidence.error !== undefined) {
		parts.push(`error: ${code(cell(evidence.error))}`);
	}
	return parts;
}

export function renderMarkdownReport(input: MarkdownReportInput): string {
	const lines: string[] = [
		`# ${input.standard} Conformance Report`,
		"",
		`| | |`,
		`| --- | --- |`,
		`| Contract | \`${input.contractId}\` |`,
		`| Network | \`${cell(input.rpcUrl)}\` |`,
		`| Run at | ${input.ranAt} |`,
		`| Checks | ${input.results.length} |`,
		"",
	];

	// The headline states a conclusion, not arithmetic. "10 of 11 passed"
	// is true and reads as near-perfect, which is exactly the overclaim a
	// reviewer would quote as "SEP-41 conformant" when one required member
	// was never exercised. So the three outcomes are named, and they match
	// exitCodeFor exactly — the document and the exit code cannot disagree.
	lines.push(`**${summarize(input.results)}**`, "");

	lines.push("## Verdicts", "");
	for (const status of [
		"PASS",
		"FAIL",
		"UNVERIFIABLE",
		"SKIPPED",
		"NOT_IMPLEMENTED",
	] as const) {
		lines.push(`- \`${status}\` — ${STATUS_MEANING[status]}`);
	}
	lines.push("");

	for (const layer of LAYER_ORDER) {
		const inLayer = input.results.filter((result) => result.layer === layer);
		if (inLayer.length === 0) {
			continue;
		}
		const passed = countByStatus(inLayer, "PASS");
		lines.push(
			`## Layer: ${layer} (${passed}/${inLayer.length} pass)`,
			"",
			"| Check | Clause | Requirement | Status | Observed |",
			"| --- | --- | --- | --- | --- |",
		);
		for (const result of inLayer) {
			lines.push(
				`| \`${result.id}\` | ${cell(result.clause)} | ${result.requirement} ` +
					`| ${BADGE[result.status]} | ${cell(result.actual)} |`,
			);
		}
		lines.push("");
		// Detail blocks come after the table rather than inside it: a
		// reviewer scans the table, then reads only the rows they doubt.
		for (const result of inLayer) {
			const evidence = evidenceLines(result);
			if (result.status === "PASS" && evidence.length === 0) {
				continue;
			}
			lines.push(`### \`${result.id}\``, "");
			lines.push(`- expected: ${result.expected}`);
			lines.push(`- observed: ${result.actual}`);
			for (const part of evidence) {
				lines.push(`- ${part}`);
			}
			lines.push("");
		}
	}

	lines.push(
		"---",
		"",
		"Generated by [soroban-guard](https://github.com/birserg/soroban-guard).",
		"Every verdict is reproducible: re-run the CLI against the same contract.",
		"",
	);
	return lines.join("\n");
}
