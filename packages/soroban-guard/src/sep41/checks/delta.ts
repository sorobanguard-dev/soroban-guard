/**
 * How a write check turns a before/after pair into a verdict.
 *
 * The write counterpart to read-outcome.ts. A read check judges one returned
 * value; a write check observes state, changes it, observes again, and judges
 * the difference. That pairing is also the evidence — a report saying
 * "holder -1, recipient +1, tx a6eecb…, ledger 4738627" is reviewable in a
 * way "PASS" is not.
 *
 * Nothing here touches the network. Give it the numbers and it decides.
 */
import type { SubmitResult } from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import type { CheckMeta } from "./shared.ts";

/** One observed quantity, labelled by role for the report. */
export interface Observation {
	readonly label: string;
	readonly before: bigint;
	readonly after: bigint;
}

export interface Expectation {
	readonly label: string;
	readonly delta: bigint;
	/**
	 * True when this party also sourced the transaction, so its balance
	 * moved by the network fee as well as by the call.
	 *
	 * Only meaningful when the asset under test *is* the fee asset — the
	 * native XLM Stellar Asset Contract, in practice. For every other token
	 * the fee is paid in a different asset and the delta is clean, so this
	 * must only be set where the measured asset is the fee asset (see
	 * `isFeeAssetContract`): set unconditionally, it would excuse any
	 * shortfall on any token as a fee the network never charged there.
	 */
	readonly paysFees?: boolean;
}

/**
 * Build the evidence bundle for a settled write.
 *
 * `after` is omitted rather than filled with placeholders when the
 * post-state could not be read: `Evidence.after` is optional, and its
 * absence says "no after-state was observed". Stringifying a failed read
 * would instead report a non-number as if it were a balance.
 */
export function writeEvidence(
	submitted: Extract<SubmitResult, { kind: "applied" }>,
	before: Readonly<Record<string, bigint>>,
	after?: Readonly<Record<string, bigint>>,
) {
	return {
		before: Object.fromEntries(
			Object.entries(before).map(([key, value]) => [key, value.toString()]),
		),
		...(after === undefined
			? {}
			: {
					after: Object.fromEntries(
						Object.entries(after).map(([key, value]) => [
							key,
							value.toString(),
						]),
					),
				}),
		txHash: submitted.txHash,
		ledger: submitted.ledger,
	};
}

/**
 * Judge observed movements against what the clause requires.
 *
 * PASS only when every expectation is met exactly. Exactness is deliberate:
 * SEP-41 gives transfer no fee semantics, so a token that credits less than
 * it debits is non-conformant, not merely unusual.
 */
export function assertDeltas(
	meta: CheckMeta,
	expected: string,
	observations: readonly Observation[],
	expectations: readonly Expectation[],
	evidence: CheckResult["evidence"],
	durationMs: number,
): CheckResult {
	if (expectations.length === 0) {
		// Unreachable today; fail loud, never vacuous-PASS.
		throw new RangeError("assertDeltas needs at least one expectation");
	}
	const mismatches: string[] = [];
	const moved: string[] = [];
	const feeConfounded: string[] = [];
	for (const expectation of expectations) {
		const observation = observations.find(
			(candidate) => candidate.label === expectation.label,
		);
		if (observation === undefined) {
			mismatches.push(`${expectation.label} was not observed`);
			continue;
		}
		const delta = observation.after - observation.before;
		const rendered = `${observation.label} ${delta > 0n ? "+" : ""}${delta}`;
		// A party that also paid the transaction fee, in the very asset being
		// measured, has a delta this check cannot read exactly.
		//
		// Only an *overspend* is excusable, and only in that direction: a
		// fee is always a debit, so a fee-payer short by more than expected
		// may have paid one, while a fee-payer short by less cannot have.
		//
		// What that does and does not protect. On `transfer` the holder is
		// flagged and the recipient is not, so a fee-on-transfer token —
		// which debits the holder extra *and* credits the recipient less —
		// still mismatches on the unflagged side and FAILs. Where the
		// short-changed party is itself the fee payer, as on
		// `transfer_from`, no such second observation exists: a recipient
		// credited `+1 − skim` and one credited `+1 − fee` are the same
		// number, and this reports UNVERIFIABLE rather than choose between
		// them. That is the honest answer and also a real limit — on the
		// one token where fees and balances share an asset, a
		// recipient-side skim is not distinguishable from the network's own
		// charge.
		if (expectation.paysFees === true && delta < expectation.delta) {
			feeConfounded.push(
				`${rendered}, expected ${expectation.delta > 0n ? "+" : ""}${expectation.delta} before the transaction fee this account also paid in the same asset`,
			);
			continue;
		}
		if (delta === expectation.delta) {
			moved.push(rendered);
		} else {
			mismatches.push(
				`${rendered}, expected ${expectation.delta > 0n ? "+" : ""}${expectation.delta}`,
			);
		}
	}
	// A genuine mismatch outranks a fee-confounded one: if any party moved
	// wrongly for a reason the fee cannot explain, that is the finding, and
	// an unreadable delta elsewhere does not soften it.
	if (mismatches.length > 0) {
		return {
			...meta,
			status: "FAIL",
			expected,
			actual: mismatches.join("; "),
			evidence,
			durationMs,
		};
	}
	if (feeConfounded.length > 0) {
		return {
			...meta,
			status: "UNVERIFIABLE",
			expected,
			actual: `${feeConfounded.join("; ")}; measuring a balance in the asset that also pays the fee cannot separate the two`,
			evidence,
			durationMs,
		};
	}
	return {
		...meta,
		status: "PASS",
		expected,
		actual: moved.join(", "),
		evidence,
		durationMs,
	};
}
