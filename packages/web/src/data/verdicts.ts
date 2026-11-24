/**
 * Every `CheckStatus`, in the order a report tallies them.
 *
 * In a `.ts` file on purpose. The package's `typecheck` script is
 * `astro sync && tsc --noEmit`, and plain `tsc` has no parser for `.astro`
 * files — so a type-level guard written in a component's frontmatter
 * compiles, passes, and enforces nothing: there, removing an entry would
 * not fail the build. Here it does.
 */
import type { CheckStatus } from "soroban-guard/src/core/types.ts";

export interface TallyEntry {
	readonly status: CheckStatus;
	readonly label: string;
	/** Used as a CSS class and data attribute, so kebab-case. */
	readonly key: string;
}

export const TALLY_ORDER = [
	{ status: "PASS", label: "PASS", key: "pass" },
	{ status: "FAIL", label: "FAIL", key: "fail" },
	{ status: "UNVERIFIABLE", label: "UNVERIFIABLE", key: "unverifiable" },
	{ status: "SKIPPED", label: "SKIPPED", key: "skipped" },
	{
		status: "NOT_IMPLEMENTED",
		label: "NOT IMPLEMENTED",
		key: "not-implemented",
	},
] as const satisfies readonly TallyEntry[];

// Compile-time proof the list is exhaustive: a status missing here would
// leave the counters summing below the row count, so the page would
// disagree with its own report. A CheckStatus without a place here fails
// `tsc`.
type Untallied = Exclude<CheckStatus, (typeof TALLY_ORDER)[number]["status"]>;
const _tallyIsExhaustive: [Untallied] extends [never] ? true : never = true;
void _tallyIsExhaustive;
