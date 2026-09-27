/**
 * SEP-41 §transfer — the first state-changing check.
 *
 * What this proves, and what it does not: an authorized transfer works and
 * moves exactly the stated amount between two observed balances. It does
 * NOT prove the contract checks authorization — a token missing
 * `from.require_auth()` passes this check, because we sign as the holder
 * and a correct contract and a permissive one behave identically when the
 * real owner asks. Catching that needs a negative check asserting the
 * contract *refuses* an unauthorized move. Nor is total supply observed:
 * SEP-41 declares no `total_supply`, so a mint to a third party during the
 * transfer is invisible here by construction.
 *
 * The three observations — before, submit, after — are separate ledger
 * states, and nothing can make them atomic: Soroban offers no snapshot read.
 * Other activity on either address between them shifts a balance the check
 * did not move, and the exact-delta assertion reads that as the contract
 * losing or inventing value. Use addresses dedicated to the run, and treat a
 * lone FAIL on a busy account as suspect before believing it.
 *
 * Exact delta by design (see `assertDeltas`): a fee-on-transfer token FAILs
 * here, correctly against SEP-41 — a dedicated check can classify those later.
 */
import { addressArg, amountArg, submitWrite } from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import type { Sep41Context } from "../context.ts";
import { assertDeltas, writeEvidence } from "./delta.ts";
import { type QuantityRead, readBalance } from "./quantity.ts";
import {
	type CheckMeta,
	classifyStanding,
	ISSUER_SENTINEL_BALANCE,
	isDeclared,
	notImplemented,
	SETTLED_FAILURE_ACTUAL,
	verdictHelpers,
} from "./shared.ts";

/** One unit of the token's smallest denomination: the least disruptive move. */
const TRANSFER_AMOUNT = 1n;

const transferMeta = {
	id: "sep41-transfer",
	clause: "SEP-41 §transfer",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED = "transfer moves the amount from holder to recipient";

const { unverifiable } = verdictHelpers(transferMeta, EXPECTED);

export const transferCheck = {
	...transferMeta,
	description: "transfer() moves the amount between two observed balances",
	async run(ctx: Sep41Context): Promise<CheckResult> {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "transfer")) {
			return notImplemented(transferMeta, "transfer", elapsed());
		}

		const { owner, spender } = ctx.parties;
		if (owner.signer === undefined) {
			return unverifiable(
				"no signing authority for the holder; set OWNER_SECRET to an account that both signs and holds this token",
				elapsed(),
			);
		}

		// The transfer names owner.address as the source while submitWrite
		// signs as owner.signer.address. When those differ, a contract that
		// enforces authorization correctly refuses — and the refusal would
		// be reported as its defect. The CLI already rejects the mismatch,
		// but Sep41Context is exported, so the guard belongs where the
		// context is consumed rather than only where one caller builds it.
		if (owner.signer.address !== owner.address) {
			return unverifiable(
				`the holder is ${owner.address} but the signer signs as ${owner.signer.address}; supply a signer for the holder`,
				elapsed(),
			);
		}

		// A generated recipient exists only in this process's memory and is
		// discarded at exit, so sending to one burns the unit rather than
		// moving it. The operator consented to a transfer, not to a burn.
		// A SAC blocks this by accident — no trustline — but a WASM token
		// accepts it, so the refusal has to be explicit.
		if (spender.isThrowaway) {
			return unverifiable(
				"the recipient was generated for this run and its key is discarded at exit; set SPENDER_ADDRESS to an account you control before moving real balance",
				elapsed(),
			);
		}

		// A transfer to yourself nets zero on a conformant contract, so the
		// delta assertion would FAIL it. Caught before the reads, since it
		// costs nothing to notice and saves a ledger close.
		if (owner.address === spender.address) {
			return unverifiable(
				"holder and recipient are the same address; a self-transfer nets zero and proves nothing — set SPENDER_ADDRESS to a different account",
				elapsed(),
			);
		}

		const ownerRead = await readBalance(ctx, owner.address);
		const spenderRead = await readBalance(ctx, spender.address);
		// A defective balance() is the contract's fault whichever check
		// notices it first; reporting it as "unreadable" here would
		// contradict balanceCheck's FAIL on the same response.
		for (const read of [ownerRead, spenderRead]) {
			if (read.kind === "defect") {
				return {
					...transferMeta,
					status: "FAIL",
					expected: EXPECTED,
					actual: `${read.detail}; the before state cannot be trusted`,
					evidence: read.error === "" ? {} : { error: read.error },
					durationMs: elapsed(),
				};
			}
		}
		if (ownerRead.kind !== "value" || spenderRead.kind !== "value") {
			return unverifiable(
				"balances unreadable; cannot establish a before state to compare against",
				elapsed(),
			);
		}
		const beforeOwner = ownerRead.amount;
		const beforeSpender = spenderRead.amount;
		if (beforeOwner < TRANSFER_AMOUNT) {
			return unverifiable(
				`holder has ${beforeOwner}, nothing to transfer`,
				elapsed(),
			);
		}
		// Refuse before submitting, on either side. Sending from the issuer
		// mints rather than debits; sending to it burns rather than credits.
		// Both leave a zero delta on a conformant contract, so submitting
		// would spend a ledger close only to produce a disposable verdict.
		if (beforeOwner === ISSUER_SENTINEL_BALANCE) {
			return unverifiable(
				"holder is the asset issuer (balance reads i64::MAX); sending from an issuer mints rather than debits, so the delta proves nothing — point OWNER_SECRET at a holding account",
				elapsed(),
			);
		}
		if (beforeSpender === ISSUER_SENTINEL_BALANCE) {
			return unverifiable(
				"recipient is the asset issuer (balance reads i64::MAX); sending to an issuer burns rather than credits, so the delta proves nothing — point SPENDER_ADDRESS at a non-issuer account",
				elapsed(),
			);
		}

		const submitted = await submitWrite(
			ctx.server,
			{
				contractId: ctx.contractId,
				method: "transfer",
				args: [
					addressArg(owner.address),
					addressArg(spender.address),
					amountArg(TRANSFER_AMOUNT),
				],
				signer: owner.signer,
			},
			ctx.networkPassphrase,
		);

		if (submitted.kind === "timeout") {
			// The hash goes in evidence, not only in prose: it is the handle
			// someone needs to look up what actually happened, and prose is
			// not a field a report consumer can read.
			return {
				...transferMeta,
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
			// Archived state, not a refusal — the call never executed. Reads
			// report this the same way; a write must not call it a verdict.
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
			return {
				...transferMeta,
				status: "FAIL",
				expected: EXPECTED,
				actual:
					"a transfer of an affordable amount, signed by the holder, was refused",
				evidence: { error: submitted.diagnostics },
				durationMs: elapsed(),
			};
		}

		// The transfer has applied, so a failed after-read must not discard
		// the hash: letting the throw reach the runner reports SKIPPED with
		// no evidence of a transfer that really happened.
		const before = { holder: beforeOwner, recipient: beforeSpender };
		let afterOwner: QuantityRead | null = null;
		let afterSpender: QuantityRead | null = null;
		try {
			afterOwner = await readBalance(ctx, owner.address);
			afterSpender = await readBalance(ctx, spender.address);
		} catch (error) {
			return {
				...transferMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual: "transfer applied, but reading the balances afterwards failed",
				evidence: {
					...writeEvidence(submitted, before),
					error: error instanceof Error ? error.message : String(error),
				},
				durationMs: elapsed(),
			};
		}
		if (afterOwner?.kind !== "value" || afterSpender?.kind !== "value") {
			const reason =
				afterOwner?.kind === "defect"
					? afterOwner
					: afterSpender?.kind === "defect"
						? afterSpender
						: null;
			// A defect after the transfer is the same defect as before it:
			// balanceCheck FAILs this response, and so does the prelude above.
			// Only a genuine non-answer leaves us without a verdict.
			return {
				...transferMeta,
				status: reason === null ? "UNVERIFIABLE" : "FAIL",
				expected: EXPECTED,
				actual:
					reason === null
						? "transfer applied but balances were unreadable afterwards"
						: `transfer applied, then ${reason.detail}`,
				evidence: {
					...writeEvidence(submitted, before),
					...(reason === null || reason.error === ""
						? {}
						: { error: reason.error }),
				},
				durationMs: elapsed(),
			};
		}
		const after = {
			holder: afterOwner.amount,
			recipient: afterSpender.amount,
		};
		return assertDeltas(
			transferMeta,
			EXPECTED,
			[
				{ label: "holder", before: beforeOwner, after: afterOwner.amount },
				{
					label: "recipient",
					before: beforeSpender,
					after: afterSpender.amount,
				},
			],
			[
				{ label: "holder", delta: -TRANSFER_AMOUNT },
				{ label: "recipient", delta: TRANSFER_AMOUNT },
			],
			writeEvidence(submitted, before, after),
			elapsed(),
		);
	},
};
