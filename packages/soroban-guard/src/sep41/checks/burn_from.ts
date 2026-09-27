/**
 * SEP-41 §burn_from — a spender destroys the holder's tokens using the
 * allowance that authorised it.
 *
 * Two quantities move: the holder is debited and the allowance drawn down.
 * Nothing is credited, because a burn destroys rather than relocates — so
 * the spender's own balance must not change, and the allowance must fall by
 * the amount burned. A contract that burns without consuming the allowance
 * has left a standing permit to destroy more.
 *
 * Like transfer_from, the allowance is established here rather than assumed,
 * and the setup's failure reports UNVERIFIABLE rather than a verdict. Signed
 * by the spender, per `spender.require_auth()` in the clause.
 *
 * Irreversible: the tokens are gone. One unit, and every guard that protects
 * the operator applies.
 *
 * Non-atomic, and more so than burn: this spans six reads and two submissions
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

const BURN_AMOUNT = 1n;

const burnFromMeta = {
	id: "sep41-burn_from",
	clause: "SEP-41 §burn_from",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED =
	"burn_from removes the amount from the holder and consumes the allowance";

const { unverifiable, failed } = verdictHelpers(burnFromMeta, EXPECTED);

export const burnFromCheck = {
	...burnFromMeta,
	description: "burn_from() burns the amount and draws down the allowance",
	async run(ctx: Sep41Context): Promise<CheckResult> {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "burn_from")) {
			return notImplemented(burnFromMeta, "burn_from", elapsed());
		}

		const { owner, spender } = ctx.parties;
		if (owner.signer === undefined || spender.signer === undefined) {
			return unverifiable(
				"burn_from needs both keys: OWNER_SECRET to grant the allowance and SPENDER_SECRET to spend it",
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
				"holder and spender are the same address; burning your own tokens is the burn clause, not this one — set SPENDER_ADDRESS to a different account",
				elapsed(),
			);
		}

		const beforeOwner = await readBalance(ctx, owner.address);
		// The header promises the spender's own balance does not change — a
		// contract that debited both would be double-spending — so it has to
		// be observed, not assumed.
		const beforeSpender = await readBalance(ctx, spender.address);
		// Defects first across both reads (transfer.ts precedent): a missing
		// answer on one must not mask a defect on the other.
		for (const read of [beforeOwner, beforeSpender]) {
			if (read.kind === "defect") {
				return failed(
					`${read.detail}; the before state cannot be trusted`,
					elapsed(),
					read.error === "" ? {} : { error: read.error },
				);
			}
		}
		if (beforeOwner.kind !== "value") {
			return unverifiable(
				"balance unreadable; cannot establish a before state to compare against",
				elapsed(),
			);
		}
		if (beforeOwner.amount < BURN_AMOUNT) {
			return unverifiable(
				`holder has ${beforeOwner.amount}, nothing to burn`,
				elapsed(),
			);
		}
		if (beforeOwner.amount === ISSUER_SENTINEL_BALANCE) {
			return unverifiable(
				"holder is the asset issuer (balance reads i64::MAX); burning from an issuer does not decrease it, so the delta proves nothing — point OWNER_SECRET at a holding account",
				elapsed(),
			);
		}

		// Spender already read and defect-cleared above; here only the
		// no-answer case remains.
		if (beforeSpender.kind !== "value") {
			return unverifiable(
				"spender balance unreadable; cannot establish that the burn leaves it untouched",
				elapsed(),
			);
		}

		// Setup: something must be allowed before it can be consumed.
		const seeded = await readAllowance(ctx, owner.address, spender.address);
		// A defective allowance() is the contract's fault whether it is read
		// for setup or for assertion — allowanceCheck FAILs the same
		// response, and one contract must not get two answers in one run.
		if (seeded.kind === "defect") {
			return failed(
				`${seeded.detail}; the before state cannot be trusted`,
				elapsed(),
				seeded.error === "" ? {} : { error: seeded.error },
			);
		}
		if (seeded.kind !== "value") {
			return unverifiable(
				"could not read the allowance to set up the test",
				elapsed(),
			);
		}
		// Consume a standing allowance rather than replacing it — see
		// transfer_from for the reasoning and the expiry caveat.
		// Whether this run established the allowance itself is answered by
		// the registry, not by whether setup ran just now (see transfer_from).
		if (seeded.amount < BURN_AMOUNT) {
			const approval = await submitApproval(ctx, BURN_AMOUNT, seeded.ledger);
			// A setup timeout names its hash in evidence: the approval may
			// yet apply, and a reader has to be able to look it up.
			if (approval.kind === "timeout" && approval.txHash !== "") {
				return {
					...burnFromMeta,
					status: "UNVERIFIABLE",
					expected: EXPECTED,
					actual:
						"could not establish an allowance to spend; approve must work before burn_from can be assessed",
					evidence: { txHash: approval.txHash },
					durationMs: elapsed(),
				};
			}
			if (approval.kind !== "applied") {
				return unverifiable(
					"could not establish an allowance to spend; approve must work before burn_from can be assessed",
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
		if (beforeAllowance.kind === "defect") {
			return failed(
				`${beforeAllowance.detail}; the before state cannot be trusted`,
				elapsed(),
				beforeAllowance.error === "" ? {} : { error: beforeAllowance.error },
			);
		}
		if (beforeAllowance.kind !== "value") {
			return unverifiable(
				"allowance unreadable after the setup approval",
				elapsed(),
			);
		}
		if (beforeAllowance.amount < BURN_AMOUNT) {
			return unverifiable(
				`the setup approval left an allowance of ${beforeAllowance.amount}; approve is not honouring the amount it was given`,
				elapsed(),
			);
		}

		const submitted = await submitWrite(
			ctx.server,
			{
				contractId: ctx.contractId,
				method: "burn_from",
				args: [
					addressArg(spender.address),
					addressArg(owner.address),
					amountArg(BURN_AMOUNT),
				],
				signer: spender.signer,
			},
			ctx.networkPassphrase,
		);

		const before = {
			holder: beforeOwner.amount,
			spender: beforeSpender.amount,
			allowance: beforeAllowance.amount,
		};
		if (submitted.kind === "timeout") {
			return {
				...burnFromMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual:
					submitted.txHash === ""
						? "stopped waiting, and no transaction hash was observed; the burn may still apply"
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
					"the burn was refused by the asset's own trustline policy, not by a defect in the contract",
					elapsed(),
					submitted.diagnostics,
				);
			}
			// Refusal against a grant this run did not create is not evidence —
			// consult the registry, which records only allowances watched land.
			if (
				!ctx.establishedAllowances.has(grantKey(owner.address, spender.address))
			) {
				return unverifiable(
					"the burn was refused against a standing allowance this run did not create; it may have expired, which allowance() cannot show",
					elapsed(),
					submitted.diagnostics,
				);
			}
			return failed(
				"a burn_from within an allowance the contract itself granted was refused",
				elapsed(),
				{ error: submitted.diagnostics },
			);
		}

		const settled = writeEvidence(submitted, before);
		// The burn has applied and the tokens are gone, so a failed
		// after-read must not discard the hash — it is the only handle left
		// on value that cannot be recovered.
		let afterOwner: QuantityRead;
		let afterSpender: QuantityRead;
		let afterAllowance: QuantityRead;
		try {
			afterOwner = await readBalance(ctx, owner.address);
			afterSpender = await readBalance(ctx, spender.address);
			afterAllowance = await readAllowance(ctx, owner.address, spender.address);
		} catch (error) {
			return {
				...burnFromMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual: "burn applied, but reading the state afterwards failed",
				evidence: {
					...settled,
					error: error instanceof Error ? error.message : String(error),
				},
				durationMs: elapsed(),
			};
		}
		for (const read of [afterOwner, afterSpender, afterAllowance]) {
			if (read.kind === "defect") {
				return failed(`burn applied, then ${read.detail}`, elapsed(), {
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
				...burnFromMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual: "burn applied but the state was unreadable afterwards",
				evidence: settled,
				durationMs: elapsed(),
			};
		}

		return assertDeltas(
			burnFromMeta,
			EXPECTED,
			[
				{
					label: "holder",
					before: beforeOwner.amount,
					after: afterOwner.amount,
				},
				{
					label: "spender",
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
				{ label: "holder", delta: -BURN_AMOUNT },
				// The spender authorises the burn but pays nothing for it, so
				// debiting it too would be a double-spend — caught here.
				{ label: "spender", delta: 0n },
				{ label: "allowance", delta: -BURN_AMOUNT },
			],
			writeEvidence(submitted, before, {
				holder: afterOwner.amount,
				spender: afterSpender.amount,
				allowance: afterAllowance.amount,
			}),
			elapsed(),
		);
	},
};
