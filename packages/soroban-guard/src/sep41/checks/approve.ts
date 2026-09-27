/**
 * SEP-41 §approve — grant a spender permission to move the holder's balance.
 *
 * Reads the allowance, submits an approval, reads it again. Unlike transfer,
 * the assertion is an absolute value rather than a delta: SEP-41 says
 * approve "overrides any existing allowance", so a conformant contract ends
 * at exactly the approved amount regardless of what was there before. A
 * contract that added to the prior allowance instead of replacing it is
 * non-conformant, and only an absolute assertion catches that.
 *
 * The expiration is a `u32` ledger sequence, not an amount — and it must be
 * in the future, or the contract rejects an approval that is already expired.
 *
 * Non-atomic: read, submit, read spans a ledger close, and nothing can make
 * the three one observation. Another approval landing between them — the
 * holder's own wallet, a script — leaves an allowance this check did not
 * set, and the absolute assertion reads that as the contract ignoring the
 * amount it was given. Use addresses dedicated to the run.
 *
 * What this does not check: that the expiration was stored as given.
 * `allowance()` returns the amount alone, so a contract that accepted the
 * approval and then set an arbitrary `live_until_ledger` — or none — is
 * indistinguishable here from one that honoured it. The amount is the whole
 * observable, and a PASS claims no more than that.
 */
import {
	addressArg,
	amountArg,
	ledgerArg,
	submitWrite,
} from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import type { Sep41Context } from "../context.ts";
import { writeEvidence } from "./delta.ts";
import { readAllowance } from "./quantity.ts";
import {
	type CheckMeta,
	classifyStanding,
	isDeclared,
	notImplemented,
	SETTLED_FAILURE_ACTUAL,
	verdictHelpers,
} from "./shared.ts";

/** One unit: enough to prove the allowance moved, small enough to be safe. */
const APPROVE_AMOUNT = 1n;

/**
 * The amount of a second, confirming approval.
 *
 * Needed only when the allowance starts at zero, where overwrite and
 * accumulate agree — `0 + 1` and `1` are the same number, so one approval
 * cannot tell a conformant contract from one that adds. Approving again
 * with a different amount separates them: overwriting lands exactly here,
 * accumulating lands on the sum.
 */
const CONFIRM_AMOUNT = 2n;

/**
 * How far ahead to set the expiration. Far enough that the approval is
 * unambiguously live when the contract evaluates it, short enough that a
 * forgotten allowance lapses on its own — roughly a day at 5s ledgers.
 */
const EXPIRATION_LEDGERS = 17_280;

const approveMeta = {
	id: "sep41-approve",
	clause: "SEP-41 §approve",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED = "approve sets the spender's allowance to the given amount";

const { unverifiable } = verdictHelpers(approveMeta, EXPECTED);

/**
 * The registry key for an owner→spender grant. Amounts and expiries are
 * deliberately not part of it: the registry answers "did this run create
 * an allowance here", and a fresh grant cannot have expired no matter
 * the amount.
 */
export function grantKey(owner: string, spender: string): string {
	return `${owner}:${spender}`;
}

/**
 * Submit one approval. Exported because transfer_from and burn_from need an
 * allowance to exist before they can test anything, and duplicating the
 * argument encoding in three places is how the amount and the expiration
 * end up with different widths in two of them.
 *
 * Records applied grants in the run registry: an approval this run watched
 * land is fresh by construction, which is the only expiry proof
 * `allowance()` can never give (it returns the amount alone).
 */
export async function submitApproval(
	ctx: Sep41Context,
	amount: bigint,
	currentLedger: number,
	/**
	 * Ledgers the grant should live for, when the caller needs something
	 * other than the usual day.
	 *
	 * The expiry check wants a grant that lapses within the run, which is
	 * the one case where a shorter life is the point rather than a mistake.
	 * Such a grant must **not** reach the registry — see `register`.
	 */
	lifetimeLedgers: number = EXPIRATION_LEDGERS,
	/**
	 * Whether an applied grant joins the run registry, which means "this
	 * run watched it land, so it is fresh and a refusal is the contract's
	 * answer rather than a lapsed deadline".
	 *
	 * Stated by the caller rather than inferred from `lifetimeLedgers`.
	 * Deriving it from the lifetime reads the length as a proxy for the
	 * intent, so a future caller that passes the default number explicitly —
	 * for reasons of its own — would be registered by coincidence. A grant
	 * built to expire is the opposite of the registry's claim, and that is
	 * a fact about why it was made, not about how long it lives.
	 */
	register = true,
): Promise<ReturnType<typeof submitWrite>> {
	const { owner, spender } = ctx.parties;
	if (owner.signer === undefined) {
		throw new Error("submitApproval requires a signer for the holder");
	}
	const result = await submitWrite(
		ctx.server,
		{
			contractId: ctx.contractId,
			method: "approve",
			args: [
				addressArg(owner.address),
				addressArg(spender.address),
				amountArg(amount),
				ledgerArg(currentLedger + lifetimeLedgers),
			],
			signer: owner.signer,
		},
		ctx.networkPassphrase,
	);
	if (result.kind === "applied" && register) {
		ctx.establishedAllowances.add(grantKey(owner.address, spender.address));
	}
	return result;
}

export const approveCheck = {
	...approveMeta,
	description: "approve() sets the spender's allowance to the given amount",
	async run(ctx: Sep41Context): Promise<CheckResult> {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "approve")) {
			return notImplemented(approveMeta, "approve", elapsed());
		}

		const { owner, spender } = ctx.parties;
		if (owner.signer === undefined) {
			return unverifiable(
				"no signing authority for the holder; set OWNER_SECRET to the account granting the allowance",
				elapsed(),
			);
		}
		if (owner.signer.address !== owner.address) {
			return unverifiable(
				`the holder is ${owner.address} but the signer signs as ${owner.signer.address}; supply a signer for the holder`,
				elapsed(),
			);
		}
		// Approving yourself is not a meaningful grant, and a contract may
		// reasonably refuse it — which would read as a defect.
		if (owner.address === spender.address) {
			return unverifiable(
				"holder and spender are the same address; an allowance to yourself proves nothing — set SPENDER_ADDRESS to a different account",
				elapsed(),
			);
		}

		const before = await readAllowance(ctx, owner.address, spender.address);
		if (before.kind === "defect") {
			return {
				...approveMeta,
				status: "FAIL",
				expected: EXPECTED,
				actual: `${before.detail}; the before state cannot be trusted`,
				evidence: before.error === "" ? {} : { error: before.error },
				durationMs: elapsed(),
			};
		}
		if (before.kind !== "value") {
			return unverifiable(
				"allowance unreadable; cannot establish a before state to compare against",
				elapsed(),
			);
		}

		// Nothing to observe: a contract whose approve writes nothing leaves
		// the allowance at the value it already held, and the assertion below
		// cannot tell that apart from one that set it correctly. Same vacuity
		// as asserting a zero balance on a generated probe.
		if (before.amount === APPROVE_AMOUNT) {
			return unverifiable(
				`the allowance is already ${APPROVE_AMOUNT}, so setting it to ${APPROVE_AMOUNT} would change nothing observable; run against a pair with a different or absent allowance`,
				elapsed(),
			);
		}

		const submitted = await submitApproval(ctx, APPROVE_AMOUNT, before.ledger);
		if (submitted.kind === "timeout") {
			return {
				...approveMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual:
					submitted.txHash === ""
						? "stopped waiting, and no transaction hash was observed; the approval may still apply"
						: `stopped waiting on ${submitted.txHash}; it may still apply`,
				evidence: submitted.txHash === "" ? {} : { txHash: submitted.txHash },
				durationMs: elapsed(),
			};
		}
		if (submitted.kind === "restore") {
			return unverifiable(
				"archived state must be restored before this call can execute",
				elapsed(),
				submitted.diagnostics,
			);
		}
		if (submitted.kind === "rejected") {
			// Reached the ledger and died there — fee, sequence race or an
			// expired footprint. None of that reached the contract's logic, so
			// a FAIL here would accuse it of a refusal it never made.
			if (submitted.settled) {
				return unverifiable(SETTLED_FAILURE_ACTUAL, elapsed(), {
					error: submitted.diagnostics,
					...(submitted.txHash === undefined
						? {}
						: { txHash: submitted.txHash }),
					...(submitted.ledger === undefined
						? {}
						: { ledger: submitted.ledger }),
				});
			}
			const standing = classifyStanding(submitted.diagnostics);
			if (standing !== null) {
				return unverifiable(
					"the approval was refused by the asset's own trustline policy, not by a defect in the contract",
					elapsed(),
					submitted.diagnostics,
				);
			}
			return {
				...approveMeta,
				status: "FAIL",
				expected: EXPECTED,
				actual: "an approval signed by the holder was refused",
				evidence: { error: submitted.diagnostics },
				durationMs: elapsed(),
			};
		}

		const evidence = writeEvidence(submitted, { allowance: before.amount });
		// The approval has applied, so a failed after-read must not discard
		// what we already know: letting the throw reach the runner reports
		// SKIPPED with no evidence of an approval that really happened.
		let after: Awaited<ReturnType<typeof readAllowance>>;
		try {
			after = await readAllowance(ctx, owner.address, spender.address);
		} catch (error) {
			return {
				...approveMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual: "approval applied, but reading the allowance afterwards failed",
				evidence: {
					...evidence,
					error: error instanceof Error ? error.message : String(error),
				},
				durationMs: elapsed(),
			};
		}
		if (after.kind === "defect") {
			return {
				...approveMeta,
				status: "FAIL",
				expected: EXPECTED,
				actual: `approval applied, then ${after.detail}`,
				evidence:
					after.error === "" ? evidence : { ...evidence, error: after.error },
				durationMs: elapsed(),
			};
		}
		if (after.kind !== "value") {
			return {
				...approveMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual: "approval applied but the allowance was unreadable afterwards",
				evidence,
				durationMs: elapsed(),
			};
		}

		// Absolute, not relative: approve overrides rather than accumulates.
		const settled = writeEvidence(
			submitted,
			{ allowance: before.amount },
			{ allowance: after.amount },
		);

		const exact = after.amount === APPROVE_AMOUNT;
		if (!exact) {
			return {
				...approveMeta,
				status: "FAIL",
				expected: EXPECTED,
				actual: `allowance is ${after.amount} after approving ${APPROVE_AMOUNT}${
					after.amount === before.amount + APPROVE_AMOUNT
						? "; the approval was added to the previous allowance rather than replacing it"
						: after.amount === before.amount
							? "; the approval did not change the allowance"
							: ""
				}`,
				evidence: settled,
				durationMs: elapsed(),
			};
		}
		if (before.amount !== 0n) {
			return {
				...approveMeta,
				status: "PASS",
				expected: EXPECTED,
				actual: `allowance is ${after.amount} after approving ${APPROVE_AMOUNT}`,
				evidence: settled,
				durationMs: elapsed(),
			};
		}

		// Confirm it: starting from zero, overwrite and accumulate agree —
		// `0 + 1` and `1` are the same number — so the first approval proves
		// nothing on its own. A second approval of a different amount
		// separates them: overwriting lands exactly on it, accumulating
		// lands on the sum.
		const confirmed = await submitApproval(ctx, CONFIRM_AMOUNT, after.ledger);
		if (confirmed.kind === "timeout") {
			return {
				...approveMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual:
					confirmed.txHash === ""
						? "stopped waiting, and no transaction hash was observed; the confirming approval may still apply"
						: `stopped waiting on ${confirmed.txHash}; the confirming approval may still apply`,
				evidence: confirmed.txHash === "" ? {} : { txHash: confirmed.txHash },
				durationMs: elapsed(),
			};
		}
		if (confirmed.kind === "restore") {
			return unverifiable(
				"archived state must be restored before this call can execute",
				elapsed(),
				confirmed.diagnostics,
			);
		}
		if (confirmed.kind === "rejected") {
			// Reached the ledger and died there — fee, sequence race or an
			// expired footprint. None of that reached the contract's logic, so
			// a FAIL here would accuse it of a refusal it never made.
			if (confirmed.settled) {
				return unverifiable(SETTLED_FAILURE_ACTUAL, elapsed(), {
					error: confirmed.diagnostics,
					...(confirmed.txHash === undefined
						? {}
						: { txHash: confirmed.txHash }),
					...(confirmed.ledger === undefined
						? {}
						: { ledger: confirmed.ledger }),
				});
			}
			const standing = classifyStanding(confirmed.diagnostics);
			if (standing !== null) {
				return unverifiable(
					"the confirming approval was refused by the asset's own trustline policy, not by a defect in the contract",
					elapsed(),
					confirmed.diagnostics,
				);
			}
			return {
				...approveMeta,
				status: "FAIL",
				expected: EXPECTED,
				actual: "a confirming approval signed by the holder was refused",
				evidence: { error: confirmed.diagnostics },
				durationMs: elapsed(),
			};
		}

		let final: Awaited<ReturnType<typeof readAllowance>>;
		try {
			final = await readAllowance(ctx, owner.address, spender.address);
		} catch (error) {
			return {
				...approveMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual:
					"confirming approval applied, but reading the allowance afterwards failed",
				evidence: {
					...writeEvidence(confirmed, { allowance: after.amount }),
					error: error instanceof Error ? error.message : String(error),
				},
				durationMs: elapsed(),
			};
		}
		if (final.kind === "defect") {
			return {
				...approveMeta,
				status: "FAIL",
				expected: EXPECTED,
				actual: `confirming approval applied, then ${final.detail}`,
				evidence:
					final.error === ""
						? writeEvidence(confirmed, { allowance: after.amount })
						: {
								...writeEvidence(confirmed, { allowance: after.amount }),
								error: final.error,
							},
				durationMs: elapsed(),
			};
		}
		if (final.kind !== "value") {
			return {
				...approveMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual:
					"confirming approval applied but the allowance was unreadable afterwards",
				evidence: writeEvidence(confirmed, { allowance: after.amount }),
				durationMs: elapsed(),
			};
		}
		const confirmedSettled = {
			...settled,
			after: { allowance: final.amount.toString() },
			confirmTxHash: confirmed.txHash,
		};
		return {
			...approveMeta,
			status: final.amount === CONFIRM_AMOUNT ? "PASS" : "FAIL",
			expected: EXPECTED,
			actual:
				final.amount === CONFIRM_AMOUNT
					? `allowance is ${final.amount} after approving ${CONFIRM_AMOUNT} over ${after.amount}`
					: `allowance is ${final.amount} after approving ${CONFIRM_AMOUNT} over ${after.amount}${
							final.amount === after.amount + CONFIRM_AMOUNT
								? "; the approval was added to the previous allowance rather than replacing it"
								: final.amount === after.amount
									? "; the confirming approval did not change the allowance"
									: ""
						}`,
			evidence: confirmedSettled,
			durationMs: elapsed(),
		};
	},
};
