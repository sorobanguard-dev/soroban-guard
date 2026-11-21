import {
	type SubmitResult,
	submitWrite,
	type WriteCall,
} from "../core/invoke.ts";
import type { Check } from "../core/types.ts";
import type { Sep41Context } from "./context.ts";

/**
 * Every write a check makes — primary calls and setup approvals alike —
 * goes through here, so one place notices an outcome the run could not
 * establish and closes the run to further writes.
 */
export async function submitCheckWrite(
	ctx: Sep41Context,
	call: Omit<WriteCall, "contractId">,
): Promise<SubmitResult> {
	const pending = ctx.soundness.unresolvedWrite;
	if (pending !== undefined) {
		// `guardWriteCheck` stops a check before it starts, and each check
		// returns on its own unknown outcome, so reaching here is a bug in
		// this tool. Thrown, not reported as a timeout: that would hand
		// this call the earlier transaction's hash, as if it had been sent.
		throw new Error(
			`internal: write submitted after transaction ${pending.txHash} left the run's state unknown`,
		);
	}
	const result = await submitWrite(
		ctx.server,
		{ contractId: ctx.contractId, ...call },
		ctx.networkPassphrase,
	);
	if (result.kind === "timeout") {
		ctx.soundness.unresolvedWrite = { txHash: result.txHash };
	}
	return result;
}

/** Avoid even reading write premises after a transaction may have changed them. */
export function guardWriteCheck(
	check: Check<Sep41Context>,
): Check<Sep41Context> {
	return {
		...check,
		async run(ctx) {
			const pending = ctx.soundness.unresolvedWrite;
			if (pending === undefined) {
				return check.run(ctx);
			}
			return {
				id: check.id,
				clause: check.clause,
				layer: check.layer,
				requirement: check.requirement,
				status: "SKIPPED",
				expected: check.description,
				actual:
					"stopped submitting writes because a previous transaction may still apply",
				evidence: pending.txHash === "" ? {} : { txHash: pending.txHash },
				durationMs: 0,
			};
		},
	};
}
