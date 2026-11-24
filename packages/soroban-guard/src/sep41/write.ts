import {
	type SubmitResult,
	submitWrite,
	type WriteCall,
} from "../core/invoke.ts";
import type { Check } from "../core/types.ts";
import type { Sep41Context } from "./context.ts";

/**
 * Record that a transaction of this run settled in `ledger`, so later reads
 * and simulations describe state from it or after. A ledger that is not
 * one, or an older one, changes nothing.
 */
export function noteSettled(
	soundness: Sep41Context["soundness"],
	ledger: number | undefined,
): void {
	if (
		ledger !== undefined &&
		Number.isSafeInteger(ledger) &&
		ledger > 0 &&
		ledger > (soundness.settledThrough ?? 0)
	) {
		soundness.settledThrough = ledger;
	}
}

/**
 * Every write a check makes, setup approvals included, goes through here,
 * so one place notices an unknown outcome and closes the run to further
 * writes, and one place keeps each write's simulation, and every read
 * after it, from describing state before the run's latest settled
 * transaction. A failed one counts: it was applied, and charged its fee.
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
	const minLedger = Math.max(
		call.minLedger ?? 0,
		ctx.soundness.settledThrough ?? 0,
	);
	const result = await submitWrite(
		ctx.server,
		{
			contractId: ctx.contractId,
			...call,
			...(minLedger > 0 ? { minLedger } : {}),
		},
		ctx.networkPassphrase,
	);
	if (result.kind === "applied" || result.kind === "rejected") {
		noteSettled(ctx.soundness, result.ledger);
	}
	if (result.kind === "timeout") {
		ctx.soundness.unresolvedWrite = {
			txHash: result.txHash,
			...(result.window === undefined ? {} : { window: result.window }),
			...(result.progress === undefined ? {} : { progress: result.progress }),
		};
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
