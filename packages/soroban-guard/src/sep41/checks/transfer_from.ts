/**
 * SEP-41 §transfer_from — a spender moves the holder's balance on their
 * behalf, consuming the allowance that authorised it.
 *
 * Three quantities move at once, and all three are asserted: the holder is
 * debited, the recipient credited, and the allowance drawn down by the same
 * amount. That last one is what distinguishes this from transfer — a
 * contract that moved the tokens but left the allowance untouched has
 * granted an unlimited permit, which is a drain waiting to happen.
 *
 * The allowance is established by this check rather than assumed. Depending
 * on approve having run first would make an approve failure surface as a
 * transfer_from verdict, and would stop either check from running alone.
 * So a setup approval is submitted first, and its failure reports
 * UNVERIFIABLE — a fact about the run, not about transfer_from.
 *
 * Signed by the spender, not the holder: `spender.require_auth()` is what
 * the clause specifies, so `SPENDER_SECRET` is what this needs.
 *
 * Non-atomic, and more so than transfer: this spans seven reads and two submissions
 * across separate ledger states, with no snapshot read available. Other
 * activity on either address in that window shifts a quantity the check did
 * not move, and the exact-delta assertion reads it as the contract losing or
 * inventing value. Use addresses dedicated to the run.
 */
import { addressArg, amountArg, submitWrite } from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import type { Sep41Context } from "../context.ts";
import { grantKey, submitApproval } from "./approve.ts";
import { assertDeltas, writeEvidence } from "./delta.ts";
import { type QuantityRead, readAllowance, readBalance } from "./quantity.ts";
import {
	type CheckMeta,
	classifyStanding,
	ISSUER_SENTINEL_BALANCE,
	isDeclared,
	notImplemented,
	SETTLED_FAILURE_ACTUAL,
	setupEvidence,
	verdictHelpers,
} from "./shared.ts";

const MOVE_AMOUNT = 1n;

const transferFromMeta = {
	id: "sep41-transfer_from",
	clause: "SEP-41 §transfer_from",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED =
	"transfer_from moves the amount and consumes the spender's allowance";

const { unverifiable, failed } = verdictHelpers(transferFromMeta, EXPECTED);

/** A defect is the contract's fault; anything else leaves us without a baseline. */
function baselineProblem(
	read: QuantityRead,
	elapsed: () => number,
): CheckResult | null {
	if (read.kind === "defect") {
		return failed(
			`${read.detail}; the before state cannot be trusted`,
			elapsed(),
			read.error === "" ? {} : { error: read.error },
		);
	}
	if (read.kind !== "value") {
		return unverifiable(
			`${read.detail}; cannot establish a before state to compare against`,
			elapsed(),
		);
	}
	return null;
}

export const transferFromCheck = {
	...transferFromMeta,
	description: "transfer_from() moves the amount and draws down the allowance",
	async run(ctx: Sep41Context): Promise<CheckResult> {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "transfer_from")) {
			return notImplemented(transferFromMeta, "transfer_from", elapsed());
		}

		const { owner, spender } = ctx.parties;
		// Two signers, two reasons. The holder's key creates the allowance;
		// the spender's key exercises it. Stated together so an operator
		// learns both requirements in one run rather than two.
		if (owner.signer === undefined || spender.signer === undefined) {
			return unverifiable(
				"transfer_from needs both keys: OWNER_SECRET to grant the allowance and SPENDER_SECRET to spend it",
				elapsed(),
			);
		}
		if (
			owner.signer.address !== owner.address ||
			spender.signer.address !== spender.address
		) {
			return unverifiable(
				"a signer does not match the party it signs for; supply keys for the addresses under test",
				elapsed(),
			);
		}
		if (owner.address === spender.address) {
			return unverifiable(
				"holder and spender are the same address; a self-transfer nets zero and consumes no allowance — set SPENDER_ADDRESS to a different account",
				elapsed(),
			);
		}
		// The spender is also the recipient here, and a generated address's
		// key is discarded at exit — so the move would burn the unit rather
		// than relocate it. Same guard transfer makes, for the same reason.
		if (spender.isThrowaway) {
			return unverifiable(
				"the spender was generated for this run and its key is discarded at exit; set SPENDER_ADDRESS to an account you control before moving real balance",
				elapsed(),
			);
		}

		const beforeOwner = await readBalance(ctx, owner.address);
		const beforeSpender = await readBalance(ctx, spender.address);
		// Defects first across both reads (transfer.ts precedent): a missing
		// answer on one must not mask a defect on the other — the contract
		// is at fault in exactly one of those cases.
		for (const read of [beforeOwner, beforeSpender]) {
			if (read.kind === "defect") {
				return failed(
					`${read.detail}; the before state cannot be trusted`,
					elapsed(),
					read.error === "" ? {} : { error: read.error },
				);
			}
		}
		const ownerProblem = baselineProblem(beforeOwner, elapsed);
		if (ownerProblem !== null) {
			return ownerProblem;
		}
		const spenderProblem = baselineProblem(beforeSpender, elapsed);
		if (spenderProblem !== null) {
			return spenderProblem;
		}
		// Unreachable — baselineProblem returned above for every non-value
		// kind — but it is what narrows the union for the reads below, so it
		// stays. Removing it costs eight type errors, not one dead branch.
		if (beforeOwner.kind !== "value" || beforeSpender.kind !== "value") {
			return unverifiable("balances unreadable", elapsed());
		}
		if (beforeOwner.amount < MOVE_AMOUNT) {
			return unverifiable(
				`holder has ${beforeOwner.amount}, nothing to transfer`,
				elapsed(),
			);
		}
		if (
			beforeOwner.amount === ISSUER_SENTINEL_BALANCE ||
			beforeSpender.amount === ISSUER_SENTINEL_BALANCE
		) {
			return unverifiable(
				"one party is the asset issuer (balance reads i64::MAX); issuer transfers mint or burn rather than move, so the delta proves nothing",
				elapsed(),
			);
		}

		// Setup, not assertion: the allowance has to exist before there is
		// anything to consume. A failure here says nothing about
		// transfer_from, so it never reaches a verdict.
		const seeded = await readAllowance(ctx, owner.address, spender.address);
		// A defective allowance() is the contract's fault whether it is read
		// for setup or for assertion — allowanceCheck FAILs the same
		// response, and one contract must not get two answers in one run.
		const seededProblem = baselineProblem(seeded, elapsed);
		if (seededProblem !== null) {
			return seededProblem;
		}
		if (seeded.kind !== "value") {
			return unverifiable("allowance unreadable", elapsed());
		}
		// Consume a standing allowance rather than replacing it. SEP-41's
		// approve overrides, so seeding over an operator's real grant of
		// 5000 would leave 1, then spend it to 0 — destroying something we
		// were only borrowing. Spending one unit of it instead is the same
		// assertion and leaves 4999 behind.
		//
		// The caveat this cannot check: allowance() returns the amount but
		// not its live_until_ledger, so a standing grant that expires before
		// the submit lands reads as sufficient and is then refused. That
		// refusal reports UNVERIFIABLE via the setup path below rather than
		// accusing the contract.
		// Whether this run established the allowance itself is answered by
		// the registry, not by whether setup ran just now: an earlier
		// check's approval (approve runs first in the suite) is as fresh
		// as one this check just watched land, while a standing grant from
		// elsewhere may have expired — allowance() returns the amount but
		// never its live_until_ledger.
		if (seeded.amount < MOVE_AMOUNT) {
			const approval = await submitApproval(ctx, MOVE_AMOUNT, seeded.ledger);
			// A setup timeout names its hash in evidence rather than the
			// error slot: the approval may yet apply, and a reader has to
			// be able to look it up.
			if (approval.kind === "timeout" && approval.txHash !== "") {
				return {
					...transferFromMeta,
					status: "UNVERIFIABLE",
					expected: EXPECTED,
					actual:
						"could not establish an allowance to spend; approve must work before transfer_from can be assessed",
					evidence: { txHash: approval.txHash },
					durationMs: elapsed(),
				};
			}
			if (approval.kind !== "applied") {
				return unverifiable(
					"could not establish an allowance to spend; approve must work before transfer_from can be assessed",
					elapsed(),
					setupEvidence(approval),
				);
			}
		}

		const beforeAllowance = await readAllowance(
			ctx,
			owner.address,
			spender.address,
		);
		const allowanceProblem = baselineProblem(beforeAllowance, elapsed);
		if (allowanceProblem !== null) {
			return allowanceProblem;
		}
		if (beforeAllowance.kind !== "value") {
			return unverifiable(
				"allowance unreadable after the setup approval",
				elapsed(),
			);
		}
		if (beforeAllowance.amount < MOVE_AMOUNT) {
			return unverifiable(
				`the setup approval left an allowance of ${beforeAllowance.amount}; approve is not honouring the amount it was given`,
				elapsed(),
			);
		}

		const submitted = await submitWrite(
			ctx.server,
			{
				contractId: ctx.contractId,
				method: "transfer_from",
				args: [
					addressArg(spender.address),
					addressArg(owner.address),
					addressArg(spender.address),
					amountArg(MOVE_AMOUNT),
				],
				// The spender authorises this, not the holder.
				signer: spender.signer,
			},
			ctx.networkPassphrase,
		);

		const before = {
			holder: beforeOwner.amount,
			recipient: beforeSpender.amount,
			allowance: beforeAllowance.amount,
		};
		if (submitted.kind === "timeout") {
			return {
				...transferFromMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual:
					submitted.txHash === ""
						? "stopped waiting, and no transaction hash was observed; the transfer may still apply"
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
			if (classifyStanding(submitted.diagnostics) !== null) {
				return unverifiable(
					"the transfer was refused by the asset's own trustline policy, not by a defect in the contract",
					elapsed(),
					submitted.diagnostics,
				);
			}
			// A refusal against a grant this run did not create is not evidence:
			// it predates the run and may have expired, and allowance() shows
			// the amount but never its live_until_ledger, so expiry reads
			// exactly like refusal. Only a suite-established allowance is one
			// the contract is answerable for — the FAIL below keeps its claim
			// because this branch is the only way to reach it.
			if (
				!ctx.establishedAllowances.has(grantKey(owner.address, spender.address))
			) {
				return unverifiable(
					"the transfer was refused against a standing allowance this run did not create; it may have expired, which allowance() cannot show",
					elapsed(),
					submitted.diagnostics,
				);
			}
			return failed(
				"a transfer_from within an allowance the contract itself granted was refused",
				elapsed(),
				{ error: submitted.diagnostics },
			);
		}

		const settled = writeEvidence(submitted, before);
		// The transfer has applied, so a failed after-read must not discard
		// the hash: letting the throw reach the runner reports SKIPPED with
		// no evidence of a transfer that really happened.
		let afterOwner: QuantityRead;
		let afterSpender: QuantityRead;
		let afterAllowance: QuantityRead;
		try {
			afterOwner = await readBalance(ctx, owner.address);
			afterSpender = await readBalance(ctx, spender.address);
			afterAllowance = await readAllowance(ctx, owner.address, spender.address);
		} catch (error) {
			return {
				...transferFromMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual: "transfer applied, but reading the state afterwards failed",
				evidence: {
					...settled,
					error: error instanceof Error ? error.message : String(error),
				},
				durationMs: elapsed(),
			};
		}
		for (const read of [afterOwner, afterSpender, afterAllowance]) {
			if (read.kind === "defect") {
				return failed(`transfer applied, then ${read.detail}`, elapsed(), {
					...settled,
					...(read.error === "" ? {} : { error: read.error }),
				});
			}
		}
		if (
			afterOwner.kind !== "value" ||
			afterSpender.kind !== "value" ||
			afterAllowance.kind !== "value"
		) {
			return {
				...transferFromMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual: "transfer applied but the state was unreadable afterwards",
				evidence: settled,
				durationMs: elapsed(),
			};
		}

		// The allowance draw-down is the clause's distinguishing requirement:
		// moving the tokens without consuming it leaves a standing permit.
		return assertDeltas(
			transferFromMeta,
			EXPECTED,
			[
				{
					label: "holder",
					before: beforeOwner.amount,
					after: afterOwner.amount,
				},
				{
					label: "recipient",
					before: beforeSpender.amount,
					after: afterSpender.amount,
				},
				{
					label: "allowance",
					before: beforeAllowance.amount,
					after: afterAllowance.amount,
				},
			],
			[
				{ label: "holder", delta: -MOVE_AMOUNT },
				{ label: "recipient", delta: MOVE_AMOUNT },
				{ label: "allowance", delta: -MOVE_AMOUNT },
			],
			writeEvidence(submitted, before, {
				holder: afterOwner.amount,
				recipient: afterSpender.amount,
				allowance: afterAllowance.amount,
			}),
			elapsed(),
		);
	},
};
