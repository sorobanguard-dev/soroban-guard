/**
 * Negative checks: clauses whose requirement is that the contract *refuses*.
 *
 * Every other check in this suite confirms something works. These confirm
 * something does not, which inverts the verdict mapping — a refusal is the
 * PASS, and a success is the finding. That inversion is the whole reason
 * they exist: a contract that never consults the allowance behaves
 * identically to a correct one whenever the spend is within a grant, so no
 * positive check can tell them apart. Only asking for something you are not
 * entitled to can.
 *
 * Note what this does *not* reach. A missing `from.require_auth()` on
 * `transfer` is the same shape of bug, but invisible here: every write in
 * the suite is signed by the party its clause names, so the call succeeds
 * whether or not the contract demanded that signature. Catching it needs a
 * call signed by the wrong party — which this check does for the allowance,
 * not for the signature.
 *
 * The same care applies in the other direction. A refusal only counts as
 * evidence of authorization enforcement when the call was otherwise able to
 * succeed: if the recipient has no trustline, or the holder has nothing to
 * take, the contract had a reason to refuse that has nothing to do with
 * permission, and claiming otherwise would credit it for a check it may not
 * perform.
 *
 * Non-atomic, and here the race threatens the premise rather than a delta:
 * the allowance is read before the attempt, so a grant landing in between —
 * the holder's own wallet, or this suite's own approve if the order ever
 * changed — makes the spender authorized after all. The attempt then
 * succeeds and reports FAIL against a contract that did exactly the right
 * thing. Use addresses dedicated to the run, and keep this check ahead of
 * approve in the suite.
 */
import { addressArg, amountArg, submitWrite } from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import type { Sep41Context } from "../context.ts";
import { readAllowance, readBalance } from "./quantity.ts";
import {
	type CheckMeta,
	classifyStanding,
	ISSUER_SENTINEL_BALANCE,
	isDeclared,
	notImplemented,
	verdictHelpers,
} from "./shared.ts";

/** Small enough to be harmless if the contract wrongly allows it. */
const ATTEMPT_AMOUNT = 1n;

const unauthorizedMeta = {
	id: "sep41-transfer_from-unauthorized",
	clause: "SEP-41 §transfer_from",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED =
	"transfer_from refuses a spender with no allowance from the holder";

const { unverifiable, failed } = verdictHelpers(unauthorizedMeta, EXPECTED);

export const unauthorizedTransferFromCheck = {
	...unauthorizedMeta,
	description: "transfer_from() refuses a spender holding no allowance",
	async run(ctx: Sep41Context): Promise<CheckResult> {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "transfer_from")) {
			return notImplemented(unauthorizedMeta, "transfer_from", elapsed());
		}

		const { owner, spender } = ctx.parties;
		if (spender.signer === undefined) {
			return unverifiable(
				"no signing authority for the spender; set SPENDER_SECRET to attempt a spend the contract should refuse",
				elapsed(),
			);
		}
		if (spender.signer.address !== spender.address) {
			return unverifiable(
				"the signer does not sign as the spender; supply a key for the address under test",
				elapsed(),
			);
		}
		if (owner.address === spender.address) {
			return unverifiable(
				"holder and spender are the same address; spending your own balance needs no allowance — set SPENDER_ADDRESS to a different account",
				elapsed(),
			);
		}
		// If the contract wrongly allows this, the unit lands on a key that
		// exists only in this process and is discarded at exit. The FAIL
		// would be correct and the tokens would still be gone, so the guard
		// stands whichever way the contract behaves.
		if (spender.isThrowaway) {
			return unverifiable(
				"the spender was generated for this run and its key is discarded at exit; set SPENDER_ADDRESS to an account you control before attempting a spend that may succeed",
				elapsed(),
			);
		}

		// The premise: there must be no allowance to violate. A leftover
		// grant from an earlier run would make a refusal meaningless and a
		// success unremarkable, so neither verdict would mean anything.
		const allowance = await readAllowance(ctx, owner.address, spender.address);
		const holding = await readBalance(ctx, owner.address);
		const recipient = await readBalance(ctx, spender.address);
		// Defects first across all three reads (transfer.ts precedent): a
		// missing answer on one must not mask a defect on another.
		for (const read of [allowance, holding, recipient]) {
			if (read.kind === "defect") {
				return failed(
					`${read.detail}; the premise cannot be established`,
					elapsed(),
					read.error === "" ? {} : { error: read.error },
				);
			}
		}
		if (allowance.kind !== "value") {
			return unverifiable(
				"allowance unreadable; cannot establish that the spender is unauthorized",
				elapsed(),
			);
		}
		if (allowance.amount > 0n) {
			return unverifiable(
				`the spender already holds an allowance of ${allowance.amount}; this check needs none, so run it before approve or against a fresh pair`,
				elapsed(),
			);
		}

		// And something worth taking: refusing to move a balance that does
		// not exist proves nothing about permission.
		if (holding.kind !== "value") {
			return unverifiable(
				"holder balance unreadable; cannot establish that there is anything to take",
				elapsed(),
			);
		}
		if (holding.amount < ATTEMPT_AMOUNT) {
			return unverifiable(
				`the holder has ${holding.amount}; a refusal would prove nothing about permission when there is nothing to move`,
				elapsed(),
			);
		}

		// An issuer breaks this check in both directions, so neither verdict
		// would mean anything. Sending *from* a SAC issuer mints rather than
		// spends, needing no allowance — the call succeeds and reports FAIL
		// for a drain that never happened. Sending *to* one burns, and a
		// refusal on those grounds would be credited as authorization
		// enforcement the contract may not perform at all.
		// Proceeding needs affirmative proof the recipient is not an issuer,
		// not merely the absence of proof that it is. An unreadable balance
		// is no evidence either way, so it stops here rather than opening
		// the gate — the same standard the holder read above is held to.
		if (recipient.kind !== "value") {
			return unverifiable(
				`recipient balance unreadable (${recipient.detail}); cannot establish that neither party is the asset issuer`,
				elapsed(),
			);
		}
		if (
			holding.amount === ISSUER_SENTINEL_BALANCE ||
			recipient.amount === ISSUER_SENTINEL_BALANCE
		) {
			return unverifiable(
				"one party is the asset issuer (balance reads i64::MAX); issuer transfers mint or burn rather than move, so neither a refusal nor a success would say anything about allowances",
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
					amountArg(ATTEMPT_AMOUNT),
				],
				signer: spender.signer,
			},
			ctx.networkPassphrase,
		);

		if (submitted.kind === "timeout") {
			// The hash goes in evidence, not only in prose: an attempt that
			// may yet apply is one a reader has to be able to look up.
			return {
				...unauthorizedMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual:
					submitted.txHash === ""
						? "stopped waiting, and no transaction hash was observed; the attempt may still apply"
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
			// A transaction that reached the ledger and failed there is not
			// the contract refusing. It may have run out of fee, lost a
			// sequence race or had its footprint expire — none of which is
			// evidence that allowances are enforced. Every other check may
			// treat this as a FAIL (a contract that cannot complete a valid
			// call is non-conformant either way), but here the mapping is
			// inverted, so crediting it would issue a clean bill of health
			// to a contract that was never asked the question.
			if (submitted.settled) {
				return unverifiable(
					"the attempt failed on-chain rather than being refused by the contract; that says nothing about whether allowances are enforced",
					elapsed(),
					submitted.diagnostics,
				);
			}
			// A standing problem is the asset's policy refusing, not the
			// contract's authorization check. Crediting it would claim
			// evidence of a check the contract may not perform at all.
			const standing = classifyStanding(submitted.diagnostics);
			if (standing !== null) {
				return unverifiable(
					"the attempt was refused by the asset's own trustline policy, which says nothing about whether the contract enforces allowances",
					elapsed(),
					submitted.diagnostics,
				);
			}
			return {
				...unauthorizedMeta,
				status: "PASS",
				expected: EXPECTED,
				actual: "an unauthorized spend was refused",
				evidence: { error: submitted.diagnostics },
				durationMs: elapsed(),
			};
		}

		// It went through. The spender held no allowance and moved the
		// holder's tokens anyway — anyone can drain any holder.
		return {
			...unauthorizedMeta,
			status: "FAIL",
			expected: EXPECTED,
			actual: `a spender with no allowance moved ${ATTEMPT_AMOUNT} of the holder's balance; any address can take from any holder`,
			evidence: { txHash: submitted.txHash, ledger: submitted.ledger },
			durationMs: elapsed(),
		};
	},
};
