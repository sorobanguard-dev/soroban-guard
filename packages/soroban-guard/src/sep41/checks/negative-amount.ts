/**
 * `transfer` must refuse a negative amount.
 *
 * SEP-41 types amounts as `i128`, which is signed — so a negative value
 * encodes cleanly and reaches the contract. Nothing in the interface gives
 * a negative transfer a meaning, and the obvious implementation of one is a
 * reversed transfer: `transfer(attacker, victim, -1)` debits the victim
 * while naming the attacker as the source, so the authorization check
 * passes on the wrong party. A contract that subtracts without a sign check
 * hands anyone a withdrawal from anyone.
 *
 * Refusing is therefore required, not a preference — a negative amount is
 * not a smaller transfer, it is a transfer in the other direction, and the
 * caller authorized neither.
 *
 * Both balances are read before submitting, for the same reason the
 * over-balance check reads them: an issuer's is a sentinel rather than a
 * holding, and a refusal on those grounds would be credited as a sign check
 * the contract never performed.
 */
import { addressArg, amountArg, submitWrite } from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import type { Sep41Context } from "../context.ts";
import { type QuantityRead, readBalance } from "./quantity.ts";
import {
	inconclusiveResult,
	type RefusalWording,
	readRefusal,
} from "./refusal.ts";
import {
	type CheckMeta,
	ISSUER_SENTINEL_BALANCE,
	isDeclared,
	notImplemented,
	verdictHelpers,
} from "./shared.ts";

/** One unit in the wrong direction: the smallest amount that has a sign. */
const ATTEMPT_AMOUNT = -1n;

const negativeAmountMeta = {
	id: "sep41-transfer-negative-amount",
	clause: "SEP-41 §transfer",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED = "transfer refuses a negative amount";

const WORDING: RefusalWording = {
	attempt: "the negative-amount transfer",
	rule: "negative amounts are rejected",
};

const { unverifiable, failed } = verdictHelpers(negativeAmountMeta, EXPECTED);

export const negativeAmountTransferCheck = {
	...negativeAmountMeta,
	description: "transfer() refuses a negative amount",
	async run(ctx: Sep41Context): Promise<CheckResult> {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "transfer")) {
			return notImplemented(negativeAmountMeta, "transfer", elapsed());
		}

		const { owner, spender } = ctx.parties;
		if (owner.signer === undefined) {
			return unverifiable(
				"no signing authority for the holder; set OWNER_SECRET to attempt a transfer the contract should refuse",
				elapsed(),
			);
		}
		if (owner.signer.address !== owner.address) {
			return unverifiable(
				"the signer does not sign as the holder; supply a key for the address under test",
				elapsed(),
			);
		}
		// A negative self-transfer nets zero however the contract reads the
		// sign, so allowing it proves nothing about the sign check.
		if (owner.address === spender.address) {
			return unverifiable(
				"holder and recipient are the same address; a self-transfer nets zero whatever the sign — set SPENDER_ADDRESS to a different account",
				elapsed(),
			);
		}
		// If the contract reads a negative transfer as a reversed one, the
		// units land on the counterparty. A generated address discards its
		// key at exit, so they would be unrecoverable.
		if (spender.isThrowaway) {
			return unverifiable(
				"the recipient was generated for this run and its key is discarded at exit; a contract that read this as a reversed transfer would move units somewhere unrecoverable — set SPENDER_ADDRESS to an account you control",
				elapsed(),
			);
		}

		const holder = await readBalance(ctx, owner.address);
		// A defective balance() is the contract's fault whichever check reads
		// it; balanceCheck FAILs the identical response.
		if (holder.kind === "defect") {
			return failed(
				`${holder.detail}; the premise cannot be established`,
				elapsed(),
				holder.error === "" ? {} : { error: holder.error },
			);
		}
		if (holder.kind !== "value") {
			return unverifiable(
				"holder balance unreadable; cannot establish a baseline to compare against",
				elapsed(),
			);
		}
		// An empty holder makes the refusal ambiguous. A contract that checks
		// `balance >= abs(amount)` refuses `-1` against a balance of 0 for
		// having nothing, not for the sign — and crediting that would claim a
		// sign check that never ran. Every sibling whose PASS depends on a
		// refusal meaning something demands a funded holder for the same
		// reason.
		if (holder.amount < 1n) {
			return unverifiable(
				`the holder has ${holder.amount}; a refusal would say the account is empty rather than anything about the sign`,
				elapsed(),
			);
		}

		const recipient = await readBalance(ctx, spender.address);
		if (recipient.kind === "defect") {
			return failed(
				`${recipient.detail}; the premise cannot be established`,
				elapsed(),
				recipient.error === "" ? {} : { error: recipient.error },
			);
		}
		// Proceeding needs proof neither party is an issuer, not merely the
		// absence of proof that one is.
		if (recipient.kind !== "value") {
			return unverifiable(
				`recipient balance unreadable (${recipient.detail}); cannot establish that neither party is the asset issuer`,
				elapsed(),
			);
		}
		if (
			holder.amount === ISSUER_SENTINEL_BALANCE ||
			recipient.amount === ISSUER_SENTINEL_BALANCE
		) {
			return unverifiable(
				"one party is the asset issuer (balance reads i64::MAX); issuer transfers mint or burn rather than move, so neither a refusal nor a success would say anything about the sign check",
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
					amountArg(ATTEMPT_AMOUNT),
				],
				signer: owner.signer,
			},
			ctx.networkPassphrase,
		);

		const reading = readRefusal(submitted, WORDING);
		if (reading.kind === "inconclusive") {
			return inconclusiveResult(
				reading,
				negativeAmountMeta,
				EXPECTED,
				elapsed(),
			);
		}
		if (reading.kind === "refused") {
			return {
				...negativeAmountMeta,
				status: "PASS",
				expected: EXPECTED,
				actual: `a transfer of ${ATTEMPT_AMOUNT} was refused`,
				evidence: {
					before: {
						holder: `${holder.amount}`,
						recipient: `${recipient.amount}`,
					},
					error: reading.diagnostics,
				},
				durationMs: elapsed(),
			};
		}

		// It went through. Which direction the units moved says which bug it
		// is — a reversed transfer (the holder gained) or a sign-blind
		// subtraction (the holder lost anyway) — and both are reportable.
		//
		// The read is guarded because the FAIL is already earned: the move
		// landed and its hash is the only handle on it. Letting a transport
		// throw escape here would reach the runner as SKIPPED and discard
		// that evidence along with the finding.
		let after: QuantityRead;
		try {
			after = await readBalance(ctx, owner.address);
		} catch (error) {
			return failed(
				`a transfer of ${ATTEMPT_AMOUNT} succeeded; the resulting balance could not be read`,
				elapsed(),
				{
					before: {
						holder: `${holder.amount}`,
						recipient: `${recipient.amount}`,
					},
					txHash: reading.txHash,
					ledger: reading.ledger,
					error: error instanceof Error ? error.message : String(error),
				},
			);
		}
		// The recipient's side, for the case the holder's alone cannot
		// describe: a reversed transfer debits the *recipient*, and if the
		// holder's own balance happens to land back where it started the
		// diagnosis would read "accepted without being refused" while a
		// third party was quietly robbed. Guarded like the read above — the
		// FAIL is already earned, so a transport throw must not discard it.
		let afterRecipient: QuantityRead | null = null;
		try {
			afterRecipient = await readBalance(ctx, spender.address);
		} catch {
			// Left null: the holder's side still carries the finding, and
			// the hash is what a reader follows.
		}
		const recipientLost =
			afterRecipient?.kind === "value" &&
			afterRecipient.amount < recipient.amount;
		const direction =
			after.kind === "value"
				? after.amount > holder.amount
					? "the holder gained, consistent with the contract reading it as a transfer in the opposite direction — anyone can withdraw from anyone"
					: after.amount < holder.amount
						? "the holder lost, consistent with the sign being discarded rather than honoured"
						: recipientLost
							? "the holder's balance is unchanged but the recipient's fell, so the call moved value out of a party that never authorized it"
							: "the holder's balance did not change, so the call was accepted without being refused"
				: after.kind === "defect"
					? `the resulting balance could not be trusted (${after.detail})`
					: "the resulting balance could not be read";
		return failed(
			`a transfer of ${ATTEMPT_AMOUNT} succeeded; ${direction}`,
			elapsed(),
			{
				before: {
					holder: `${holder.amount}`,
					recipient: `${recipient.amount}`,
				},
				after: {
					holder:
						after.kind === "value"
							? `${after.amount}`
							: after.kind === "defect"
								? "unreadable (defective read)"
								: "unreadable",
					recipient:
						afterRecipient === null
							? "unreadable"
							: afterRecipient.kind === "value"
								? `${afterRecipient.amount}`
								: afterRecipient.kind === "defect"
									? "unreadable (defective read)"
									: "unreadable",
				},
				txHash: reading.txHash,
				ledger: reading.ledger,
				...(after.kind === "defect" && after.error !== ""
					? { error: after.error }
					: {}),
			},
		);
	},
};
