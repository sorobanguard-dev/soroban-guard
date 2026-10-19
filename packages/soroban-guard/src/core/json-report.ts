/**
 * The machine-readable report: one JSON object per run.
 *
 * The third renderer over the same `CheckResult[]`, for the readers the
 * other two cannot serve — CI that wants to branch on a field rather than
 * grep text, and the browser UI, which needs data it can put in a table
 * rather than a string it would have to parse back.
 *
 * `schema` is versioned because this is the only output another program
 * consumes: text reports can be reworded freely, but a consumer reading
 * `results[0].status` breaks silently if the shape moves under it. Bump it
 * on any breaking change to the envelope.
 */
import { exitCodeFor } from "./report.ts";
import { type CheckResult, countByStatus } from "./types.ts";

export interface JsonReportInput {
	readonly standard: string;
	readonly contractId: string;
	readonly results: readonly CheckResult[];
	/** ISO-8601, passed in so the renderer stays pure and testable. */
	readonly ranAt: string;
	readonly rpcUrl: string;
	/**
	 * The soroban-guard version that ran the checks, when the caller knows
	 * it. A report quoted later is only as good as knowing which code made
	 * it. Additive, so the schema stays at @1.
	 */
	readonly toolVersion?: string;
}

/**
 * Render the run as a JSON string.
 *
 * The exit code is included rather than left for the caller to re-derive:
 * `exitCodeFor` is the single source of truth for what the run concluded,
 * and a consumer that recomputed it from statuses could reach a different
 * answer than the process actually exited with.
 */
export function renderJsonReport(input: JsonReportInput): string {
	return JSON.stringify(
		{
			schema: "soroban-guard/report@1",
			...(input.toolVersion === undefined
				? {}
				: { toolVersion: input.toolVersion }),
			standard: input.standard,
			contractId: input.contractId,
			rpcUrl: input.rpcUrl,
			ranAt: input.ranAt,
			exitCode: exitCodeFor(input.results),
			summary: {
				total: input.results.length,
				pass: countByStatus(input.results, "PASS"),
				fail: countByStatus(input.results, "FAIL"),
				unverifiable: countByStatus(input.results, "UNVERIFIABLE"),
				skipped: countByStatus(input.results, "SKIPPED"),
				notImplemented: countByStatus(input.results, "NOT_IMPLEMENTED"),
			},
			results: input.results,
		},
		null,
		2,
	);
}
