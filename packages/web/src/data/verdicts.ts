/**
 * Every `CheckStatus`, in the order a report tallies them.
 *
 * In a `.ts` file on purpose. The package's `typecheck` script is
 * `astro sync && tsc --noEmit`, and plain `tsc` has no parser for `.astro`
 * files — so a type-level guard written in a component's frontmatter
 * compiles, passes, and enforces nothing. This list used to live in
 * `Report.astro` with exactly that kind of guard beside it; removing an
 * entry did not fail the build. Here it does.
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

// Compile-time proof the list is exhaustive. An earlier version omitted
// NOT_IMPLEMENTED, and against a contract missing a member the counters
// summed below the row count — the page quietly disagreeing with its own
// report. Adding a CheckStatus without a place here now fails `tsc`.
type Untallied = Exclude<CheckStatus, (typeof TALLY_ORDER)[number]["status"]>;
const _tallyIsExhaustive: [Untallied] extends [never] ? true : never = true;
void _tallyIsExhaustive;
