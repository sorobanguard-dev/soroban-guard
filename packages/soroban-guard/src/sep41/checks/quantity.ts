/**
 * Reading a quantity the way a write check needs it.
 *
 * Every state-changing check observes a number before and after, so each
 * needs the same three-way answer: the contract is wrong, we have no answer,
 * or here is the value. Collapsing the first two — the obvious shortcut —
 * is what makes a check report UNVERIFIABLE in the same run where the
 * matching read check FAILs, one contract with two answers.
 */
import { addressArg } from "../../core/invoke.ts";
import type { Sep41Context } from "../context.ts";
import { callRead, classifyStanding, describeValue } from "./shared.ts";

export type QuantityRead =
	| { readonly kind: "value"; readonly amount: bigint; readonly ledger: number }
	| { readonly kind: "defect"; readonly detail: string; readonly error: string }
	| { readonly kind: "no-answer"; readonly detail: string };

/**
 * `method` names the SEP-41 getter so diagnostics say which one misbehaved,
 * and `noun` names what it returns for the operator-facing message.
 */
async function readQuantity(
	ctx: Sep41Context,
	method: "balance" | "allowance",
	noun: string,
	addresses: readonly string[],
): Promise<QuantityRead> {
	const { outcome, ledger, fromArchive } = await callRead(
		ctx,
		method,
		addresses.map(addressArg),
	);
	// A restored answer is last-known state, and the write will bring the
	// entry current — so an archived baseline would be differenced against a
	// fresh after-read and the gap blamed on the contract.
	if (fromArchive) {
		return {
			kind: "no-answer",
			detail: `the ${noun} came from an archived entry, not current state`,
		};
	}
	if (outcome.kind === "ok") {
		if (typeof outcome.value !== "bigint") {
			return {
				kind: "defect",
				detail: `${method}() returned ${describeValue(outcome.value)}, expected an i128`,
				error: "",
			};
		}
		// SEP-41 quantities are non-negative, and the read checks FAIL a
		// negative one — both phases of a write must match that verdict.
		//
		// Only the first one, though. Once the accounting has gone negative
		// it stays negative, and every check after this reads the same
		// wound while establishing its own premise. Repeating the FAIL
		// would report one missing bounds check as nine findings and bury
		// the one that matters, so the rest say they cannot measure
		// anything instead — which is the truth, and is what UNVERIFIABLE
		// is for.
		if (outcome.value < 0n) {
			const detail = `${method}() returned ${outcome.value}, which is negative`;
			if (ctx.soundness.firstNegative === undefined) {
				ctx.soundness.firstNegative = detail;
				return { kind: "defect", detail, error: "" };
			}
			// Naming the earlier reading only when it differs from this one:
			// a holder read twice reports the same number both times, and
			// "-1 ... (-1)" reads as a bug in the report rather than as the
			// attribution it is meant to be.
			const earlier =
				ctx.soundness.firstNegative === detail
					? ""
					: ` (first seen as ${ctx.soundness.firstNegative})`;
			return {
				kind: "no-answer",
				detail: `${detail}; this contract's accounting already went negative earlier in the run${earlier}, so nothing measured against it can be trusted`,
			};
		}
		return { kind: "value", amount: outcome.value, ledger };
	}
	if (outcome.kind === "trapped") {
		return classifyStanding(outcome.diagnostics) === null
			? {
					kind: "defect",
					detail: `${method}() trapped`,
					error: outcome.diagnostics,
				}
			: { kind: "no-answer", detail: `a ${noun} could not be read` };
	}
	return { kind: "no-answer", detail: `a ${noun} could not be read` };
}

export function readBalance(
	ctx: Sep41Context,
	address: string,
): Promise<QuantityRead> {
	return readQuantity(ctx, "balance", "balance", [address]);
}

export function readAllowance(
	ctx: Sep41Context,
	owner: string,
	spender: string,
): Promise<QuantityRead> {
	return readQuantity(ctx, "allowance", "allowance", [owner, spender]);
}
