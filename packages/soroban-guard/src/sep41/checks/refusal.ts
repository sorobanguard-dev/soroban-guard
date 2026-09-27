/**
 * How a negative check reads a submission outcome.
 *
 * Every negative check asks the same question of `submitWrite`'s result —
 * "was this the contract refusing, or something else?" — and only the
 * wording differs. Four copies of that ladder is four chances for one of
 * them to credit a fee failure as evidence of enforcement, so the ladder
 * lives here once and each check supplies its own sentences.
 *
 * The distinction is the whole value of a negative check. A refusal only
 * proves the contract enforces a rule when the call was otherwise able to
 * succeed and the contract itself is what turned it down. A ledger failure,
 * an asset-policy refusal or a timeout each look like a refusal and prove
 * nothing.
 */
import type { SubmitResult } from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import { type CheckMeta, classifyStanding } from "./shared.ts";

/** What a negative check concluded, once the outcome has been classified. */
export type RefusalReading =
	/** The contract refused, and had every chance to succeed: the PASS. */
	| { readonly kind: "refused"; readonly diagnostics: string }
	/** It went through. For a negative check that is the finding. */
	| {
			readonly kind: "allowed";
			readonly txHash: string;
			readonly ledger: number;
	  }
	/**
	 * Something other than the contract's own rule decided the outcome, so
	 * no verdict is available. `actual` is the sentence to report and
	 * `diagnostics` the evidence behind it.
	 */
	| {
			readonly kind: "inconclusive";
			readonly actual: string;
			readonly diagnostics?: string;
			readonly txHash?: string;
			/** Ledger of the transaction, when one reached it. */
			readonly ledger?: number;
	  };

/**
 * The sentences one check uses for the outcomes it cannot attribute.
 *
 * Supplied per check rather than generalized: "the burn was refused by the
 * asset's own policy" and "the spend was refused by the asset's own policy"
 * are the same finding phrased for two different operators, and a generic
 * "the call was refused" helps neither.
 */
export interface RefusalWording {
	/** What was attempted, e.g. "a transfer of more than the holder owns". */
	readonly attempt: string;
	/** What the rule under test is, e.g. "balances cannot go negative". */
	readonly rule: string;
}

/**
 * Classify a submission for a negative check.
 *
 * Order matters and is the same in every caller: a settled ledger failure
 * is checked before the asset's policy, and both before the refusal is
 * credited. Reversing any pair would let an unattributable outcome be read
 * as proof the contract enforces something.
 */
export function readRefusal(
	submitted: SubmitResult,
	wording: RefusalWording,
): RefusalReading {
	if (submitted.kind === "timeout") {
		// The hash is the handle: an attempt that may yet apply is one a
		// reader has to be able to look up.
		return {
			kind: "inconclusive",
			actual:
				submitted.txHash === ""
					? `stopped waiting, and no transaction hash was observed; ${wording.attempt} may still apply`
					: `stopped waiting on ${submitted.txHash}; ${wording.attempt} may still apply`,
			txHash: submitted.txHash === "" ? undefined : submitted.txHash,
		};
	}
	if (submitted.kind === "restore") {
		return {
			kind: "inconclusive",
			actual: "archived state must be restored before this call can execute",
			diagnostics: submitted.diagnostics,
		};
	}
	if (submitted.kind === "applied") {
		return {
			kind: "allowed",
			txHash: submitted.txHash,
			ledger: submitted.ledger,
		};
	}
	// Everything above returned, so only `rejected` remains — but the
	// default of falling through here is `refused`, which is a PASS for
	// every caller. A future `SubmitResult` kind would inherit that and
	// quietly certify a contract nobody asked. Stated rather than assumed,
	// so the next kind fails loudly instead.
	if (submitted.kind !== "rejected") {
		throw new Error(
			`unhandled submission kind: ${(submitted as { kind: string }).kind}`,
		);
	}
	// A transaction that reached the ledger and died there is not the
	// contract refusing — fee, sequence race, expired footprint. Positive
	// checks may treat it as a FAIL either way; here the mapping is
	// inverted, so crediting it would hand out a clean bill of health to a
	// contract that was never asked the question.
	if (submitted.settled) {
		return {
			kind: "inconclusive",
			actual: `the attempt failed on-chain rather than being refused by the contract; that says nothing about whether ${wording.rule}`,
			diagnostics: submitted.diagnostics,
			// It reached the ledger, so there is something to look up — the
			// same reason a timeout carries its hash.
			txHash: submitted.txHash,
			ledger: submitted.ledger,
		};
	}
	// The asset's own trustline policy refusing is not the contract's rule
	// being enforced. Crediting it claims evidence of a check the contract
	// may not perform at all.
	if (classifyStanding(submitted.diagnostics) !== null) {
		return {
			kind: "inconclusive",
			actual: `the attempt was refused by the asset's own trustline policy, which says nothing about whether ${wording.rule}`,
			diagnostics: submitted.diagnostics,
		};
	}
	return { kind: "refused", diagnostics: submitted.diagnostics };
}

/**
 * Build the UNVERIFIABLE result an `inconclusive` reading calls for.
 *
 * Not routed through `verdictHelpers.unverifiable`, which takes only an
 * error string: a timeout's evidence is a transaction hash, and dropping it
 * would leave a reader nothing to look up for the one outcome that may
 * still be in flight.
 */
export function inconclusiveResult(
	reading: Extract<RefusalReading, { kind: "inconclusive" }>,
	meta: CheckMeta,
	expected: string,
	durationMs: number,
): CheckResult {
	return {
		...meta,
		status: "UNVERIFIABLE",
		expected,
		actual: reading.actual,
		evidence: {
			...(reading.diagnostics === undefined
				? {}
				: { error: reading.diagnostics }),
			...(reading.txHash === undefined ? {} : { txHash: reading.txHash }),
			...(reading.ledger === undefined ? {} : { ledger: reading.ledger }),
		},
		durationMs,
	};
}
