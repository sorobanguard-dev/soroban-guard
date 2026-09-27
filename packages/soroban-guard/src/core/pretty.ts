/**
 * The terminal report a human actually scans.
 *
 * The plain renderer in `report.ts` prints one flat list, which is fine for
 * eleven rows and unreadable at thirty: nothing groups, nothing aligns, and
 * a FAIL looks exactly like an UNVERIFIABLE until you read the glyph. This
 * one groups by layer, aligns the ids into a column, and colours the
 * verdict — so the eye finds the failures before it reads any prose.
 *
 * Still pure: takes results and a width, returns a string. Colour and
 * terminal width arrive as arguments, never read from `process` here, so
 * every layout decision is reproducible in a test.
 */
import { padVisible, style, visibleWidth } from "./ansi.ts";
import { exitCodeFor } from "./report.ts";
import {
	type CheckResult,
	type CheckStatus,
	countByStatus,
	LAYER_ORDER,
	STATUS_GLYPH,
} from "./types.ts";

export interface PrettyInput {
	readonly standard: string;
	readonly contractId: string;
	readonly results: readonly CheckResult[];
	readonly color: boolean;
	/** Terminal columns. Long prose wraps to this rather than the terminal's
	 * own wrapping, which breaks mid-word and ignores indentation. */
	readonly width: number;
}

const COLOR: Record<CheckStatus, "green" | "red" | "yellow" | "grey"> = {
	PASS: "green",
	FAIL: "red",
	UNVERIFIABLE: "yellow",
	SKIPPED: "grey",
	NOT_IMPLEMENTED: "grey",
};

/**
 * Cut a long token into chunks no wider than `room`.
 *
 * Width is UTF-16 units — the same measure `visibleWidth` and the packing
 * below use — while iteration is by code point, so the cut can never land
 * between an emoji's surrogate halves. Counting points but measuring units
 * would let a chunk of `room` emoji run double-wide past the margin.
 */
function chunkByWidth(word: string, room: number): string[] {
	const chunks: string[] = [];
	let chunk = "";
	let width = 0;
	for (const point of word) {
		if (width + point.length > room && chunk !== "") {
			chunks.push(chunk);
			chunk = "";
			width = 0;
		}
		chunk += point;
		width += point.length;
	}
	// The loop only pushes a finished chunk, so the tail is still local —
	// without this a 64-char hash would render truncated, silently.
	if (chunk !== "") {
		chunks.push(chunk);
	}
	return chunks;
}

/**
 * Wrap prose to `width`, indenting continuations to `indent`.
 *
 * Done here rather than left to the terminal because the terminal wraps at
 * column zero: a two-line diagnostic would start flush against the left
 * margin and read as a new row rather than a continuation of this one.
 */

function wrap(text: string, width: number, indent: number): readonly string[] {
	const room = Math.max(20, width - indent);
	const pad = " ".repeat(indent);
	const lines: string[] = [];
	let current = "";
	// A token wider than the room has no break point of its own — a 64-char
	// hash or a base64 blob in an SDK diagnostic — so it is cut to fit
	// rather than allowed to run past the terminal and wrap at column zero,
	// which is exactly the ragged left edge this function exists to avoid.
	const words = text
		.split(/\s+/)
		.flatMap((word) =>
			word.length <= room ? [word] : chunkByWidth(word, room),
		);
	for (const word of words) {
		if (current === "") {
			current = word;
		} else if (current.length + 1 + word.length <= room) {
			current += ` ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current !== "") {
		lines.push(current);
	}
	return lines.map((line, index) => (index === 0 ? line : pad + line));
}

export function renderPretty(input: PrettyInput): string {
	const { color, width } = input;
	const lines: string[] = [
		"",
		`  ${style(`${input.standard} Conformance`, "bold", color)}  ${style(input.contractId, "dim", color)}`,
		"",
	];

	// One id column across every layer, so the verdicts line up even though
	// the groups print separately.
	const idWidth = Math.max(
		...input.results.map((result) => result.id.length),
		12,
	);

	for (const layer of LAYER_ORDER) {
		const inLayer = input.results.filter((result) => result.layer === layer);
		if (inLayer.length === 0) {
			continue;
		}
		const passed = countByStatus(inLayer, "PASS");
		lines.push(
			`  ${style(layer, "blue", color)} ${style(`(${passed}/${inLayer.length})`, "dim", color)}`,
		);
		for (const result of inLayer) {
			const glyph = style(
				STATUS_GLYPH[result.status],
				COLOR[result.status],
				color,
			);
			const id = padVisible(result.id, idWidth);
			const indent = 4 + visibleWidth(glyph) + 1 + idWidth + 2;
			const prose = wrap(result.actual, width, indent);
			lines.push(`    ${glyph} ${style(id, "dim", color)}  ${prose[0] ?? ""}`);
			for (const extra of prose.slice(1)) {
				lines.push(extra);
			}
			// Only a non-PASS owes an explanation; a PASS that printed its
			// expectation too would double the output for no new information.
			if (result.status !== "PASS") {
				// `wrap` already pads its own continuations to `indent`, so the
				// prefix goes on the first line only — prefixing every line
				// would indent the tail twice and stagger it off to the right.
				const detail = wrap(`expected: ${result.expected}`, width, indent);
				for (const [index, line] of detail.entries()) {
					const text = index === 0 ? `${" ".repeat(indent)}${line}` : line;
					lines.push(style(text, "dim", color));
				}
			}
		}
		lines.push("");
	}

	const failed = countByStatus(input.results, "FAIL");
	const unassessed =
		countByStatus(input.results, "UNVERIFIABLE") +
		countByStatus(input.results, "SKIPPED");
	const passed = countByStatus(input.results, "PASS");
	// Derived from exitCodeFor, not re-derived: the verdict must agree with
	// the process exit, including the two cases a FAIL/unassessed count
	// cannot see — a required member the contract does not implement (exit
	// 1) and a run that assessed nothing at all (exit 2).
	const missingRequired = input.results.filter(
		(result) =>
			result.status === "NOT_IMPLEMENTED" && result.requirement === "required",
	).length;
	let verdict: string;
	if (input.results.length === 0) {
		verdict = style("no checks ran", "yellow", color);
	} else {
		switch (exitCodeFor(input.results)) {
			case 1: {
				const parts = [
					failed > 0 ? `${failed} violation${failed === 1 ? "" : "s"}` : null,
					missingRequired > 0
						? `${missingRequired} required member${missingRequired === 1 ? "" : "s"} missing`
						: null,
				].filter((part) => part !== null);
				verdict = style(`${parts.join(", ")} found`, "red", color);
				break;
			}
			case 2:
				verdict = style(
					`no violation found, ${unassessed} unassessed`,
					"yellow",
					color,
				);
				break;
			default:
				// Exit 0 with nothing exercised: a suite of `optional`
				// members the contract does not declare. Conformant, since
				// optionality excuses absence — but green "conformant" over
				// "0/1 checks held" reads as a pass for a run that asked
				// nothing, so it says which it is.
				verdict =
					passed === 0
						? style("nothing exercised, no violation", "yellow", color)
						: style("conformant", "green", color);
		}
	}
	lines.push(
		`  ${verdict}${style(` · ${passed}/${input.results.length} checks held`, "dim", color)}`,
		"",
	);
	return lines.join("\n");
}
