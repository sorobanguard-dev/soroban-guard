import type { CheckResult, Suite } from "./types.ts";

type CheckCount = { readonly completed: number; readonly total: number };

export type CheckProgress = CheckCount &
	(
		| { readonly kind: "started"; readonly id: string }
		| { readonly kind: "finished"; readonly result: CheckResult }
	);

/**
 * Run every check in the suite, in order, collecting results. Sequential by
 * design, not `Promise.all`: checks share the source account and testnet
 * rate limits, so parallel runs would cause tx_bad_seq and throttling.
 *
 * A check that throws has suffered a harness failure (RPC down, malformed address) —
 * that is not a verdict about the contract, so it is recorded as SKIPPED
 * with the error preserved, and the run continues. One bad check never
 * aborts the suite.
 *
 * The observer receives a finished event for every recorded verdict.
 */
export async function runSuite<Ctx>(
	suite: Suite<Ctx>,
	ctx: Ctx,
	onProgress?: (event: CheckProgress) => void,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const total = suite.checks.length;
	for (const check of suite.checks) {
		onProgress?.({
			kind: "started",
			id: check.id,
			completed: results.length,
			total,
		});
		const started = Date.now();
		let result: CheckResult;
		try {
			result = await check.run(ctx);
		} catch (error) {
			result = {
				id: check.id,
				clause: check.clause,
				layer: check.layer,
				requirement: check.requirement,
				status: "SKIPPED",
				expected: check.description,
				actual: "check did not complete",
				evidence: {
					error: error instanceof Error ? error.message : String(error),
				},
				durationMs: Date.now() - started,
			};
		}
		results.push(result);
		onProgress?.({
			kind: "finished",
			result,
			completed: results.length,
			total,
		});
	}
	return results;
}
