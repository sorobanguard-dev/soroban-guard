/**
 * `transfer` must refuse to move more than the holder owns.
 *
 * The one arithmetic invariant a token cannot bend: a balance is a count of
 * units that exist, so a transfer that would take it below zero has nothing
 * to move. A contract that allows it either mints silently or wraps into a
 * huge positive — both of which let a holder spend value that was never
 * issued, and both invisible to every positive check, because a transfer of
 * an amount the holder *does* own behaves identically either way.
 *
 * Unlike the zero-amount and self-transfer cases, SEP-41 leaves no room
 * here: refusing is required, so a success is a FAIL rather than an
 * observation.
 *
 * The premise is a balance that can be read and exceeded. Asking for
 * `balance + 1` rather than a fixed large number keeps the attempt just
 * over the line: a contract could plausibly reject `u128::MAX` for an
 * encoding reason that says nothing about its arithmetic.
 *
 * Both balances are read before submitting. The holder's is the amount to
 * exceed. The recipient's is a premise: sending to a SAC issuer burns
 * rather than moves, so a contract could refuse for that reason and be
 * credited with a floor check it never performed.
 */
import {
	addressArg,
	amountArg,
	I128_MAX,
	submitWrite,
} from "../../core/invoke.ts";
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

const overBalanceMeta = {
	id: "sep41-transfer-over-balance",
	clause: "SEP-41 §transfer",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED = "transfer refuses to move more than the holder's balance";

const WORDING: RefusalWording = {
	attempt: "the over-balance transfer",
	rule: "balances are prevented from going negative",
};

const { unverifiable, failed } = verdictHelpers(overBalanceMeta, EXPECTED);

export const overBalanceTransferCheck = {
	...overBalanceMeta,
	description: "transfer() refuses an amount greater than the holder's balance",
	async run(ctx: Sep41Context): Promise<CheckResult> {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "transfer")) {
			return notImplemented(overBalanceMeta, "transfer", elapsed());
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
		// A conformant contract refuses, so nothing lands anywhere and the
		// recipient's nature is usually irrelevant. This guard is for the
		// contract that does *not* refuse: the FAIL would be correct, and the
		// holder's entire balance plus one would have moved to a key this
		// process discards at exit. The same standard transfer holds, for a
		// larger amount.
		if (spender.isThrowaway) {
			return unverifiable(
				"the recipient was generated for this run and its key is discarded at exit; a contract that wrongly allowed this would move the whole balance somewhere unrecoverable — set SPENDER_ADDRESS to an account you control",
				elapsed(),
			);
		}
		// A self-transfer of any size nets zero, so a contract could allow it
		// without ever doing the arithmetic this check is asking about.
		if (owner.address === spender.address) {
			return unverifiable(
				"holder and recipient are the same address; a self-transfer nets zero whatever the amount, so it cannot test the balance floor — set SPENDER_ADDRESS to a different account",
				elapsed(),
			);
		}

		const before = await readBalance(ctx, owner.address);
		// A defective balance() is the contract's fault whether it is read to
		// establish a premise or to assert one — balanceCheck FAILs the same
		// response, and one contract must not get two answers in a run.
		if (before.kind === "defect") {
			return failed(
				`${before.detail}; the premise cannot be established`,
				elapsed(),
				before.error === "" ? {} : { error: before.error },
			);
		}
		if (before.kind !== "value") {
			return unverifiable(
				"holder balance unreadable; cannot establish what exceeding it would mean",
				elapsed(),
			);
		}
		// Refusing an empty holder proves nothing about arithmetic: there is
		// nothing to move, so any implementation refuses. The floor is only
		// tested when something exists to take.
		if (before.amount < 1n) {
			return unverifiable(
				`the holder has ${before.amount}; a refusal would prove nothing about the balance floor when there is nothing to move`,
				elapsed(),
			);
		}
		// The issuer's balance is a sentinel, not a holding: a SAC issuer
		// mints on payout, so no amount exceeds what it can send and the
		// premise is unreachable rather than merely hard to establish.
		if (before.amount === ISSUER_SENTINEL_BALANCE) {
			return unverifiable(
				"the holder is the asset issuer (balance reads i64::MAX); issuer transfers mint rather than move, so no amount exceeds the balance",
				elapsed(),
			);
		}

		// The recipient cannot be the issuer either: sending to one burns
		// rather than moves, so neither a refusal nor a success would say
		// anything about the floor. Read, not assumed — an unreadable
		// balance is no proof either way.
		const recipient = await readBalance(ctx, spender.address);
		if (recipient.kind === "defect") {
			return failed(
				`${recipient.detail}; the premise cannot be established`,
				elapsed(),
				recipient.error === "" ? {} : { error: recipient.error },
			);
		}
		if (recipient.kind !== "value") {
			return unverifiable(
				`recipient balance unreadable (${recipient.detail}); cannot establish that neither party is the asset issuer`,
				elapsed(),
			);
		}
		if (recipient.amount === ISSUER_SENTINEL_BALANCE) {
			return unverifiable(
				"the recipient is the asset issuer (balance reads i64::MAX); sending to an issuer burns rather than moves, so the outcome would say nothing about the balance floor",
				elapsed(),
			);
		}

		// One unit past what exists. Deliberately not a huge number: a
		// contract may reject u128::MAX for encoding reasons that say nothing
		// about whether it checks the floor.
		//
		// Bounded above by what the encoder accepts: a balance at i128::MAX
		// would make the attempt unencodable, and the throw would escape as
		// SKIPPED rather than report that the floor cannot be tested.
		if (before.amount >= I128_MAX) {
			return unverifiable(
				`the holder balance is ${before.amount}, at the top of the i128 range; one past it cannot be encoded, so the floor cannot be tested`,
				elapsed(),
			);
		}
		const attempt = before.amount + 1n;
		const submitted = await submitWrite(
			ctx.server,
			{
				contractId: ctx.contractId,
				method: "transfer",
				args: [
					addressArg(owner.address),
					addressArg(spender.address),
					amountArg(attempt),
				],
				signer: owner.signer,
			},
			ctx.networkPassphrase,
		);

		const reading = readRefusal(submitted, WORDING);
		if (reading.kind === "inconclusive") {
			return inconclusiveResult(reading, overBalanceMeta, EXPECTED, elapsed());
		}
		if (reading.kind === "refused") {
			return {
				...overBalanceMeta,
				status: "PASS",
				expected: EXPECTED,
				actual: `a transfer of ${attempt} against a balance of ${before.amount} was refused`,
				evidence: {
					before: {
						holder: `${before.amount}`,
						recipient: `${recipient.amount}`,
					},
					error: reading.diagnostics,
				},
				durationMs: elapsed(),
			};
		}

		// It went through. The after-read records where the holder's balance
		// landed, which is the damage a reader needs — not a diagnosis:
		// telling a silent mint from a wrapped subtraction would need the
		// recipient's side too, and this check only re-reads the holder.
		// A failed after-read must not discard the hash: the move really
		// happened, and the hash is the only handle on it.
		let after: QuantityRead | null = null;
		try {
			after = await readBalance(ctx, owner.address);
		} catch (error) {
			return failed(
				`a transfer of ${attempt} succeeded against a balance of ${before.amount}; the holder can move value that was never issued (balance unreadable after the move)`,
				elapsed(),
				{
					before: {
						holder: `${before.amount}`,
						recipient: `${recipient.amount}`,
					},
					txHash: reading.txHash,
					ledger: reading.ledger,
					error: error instanceof Error ? error.message : String(error),
				},
			);
		}
		if (after.kind === "defect") {
			return failed(
				`a transfer of ${attempt} succeeded against a balance of ${before.amount}; the holder can move value that was never issued (${after.detail})`,
				elapsed(),
				{
					before: {
						holder: `${before.amount}`,
						recipient: `${recipient.amount}`,
					},
					txHash: reading.txHash,
					ledger: reading.ledger,
					...(after.error === "" ? {} : { error: after.error }),
				},
			);
		}
		const observed =
			after.kind === "value" ? `${after.amount}` : "unreadable after the move";
		return failed(
			`a transfer of ${attempt} succeeded against a balance of ${before.amount}; the holder can move value that was never issued (balance now ${observed})`,
			elapsed(),
			{
				before: {
					holder: `${before.amount}`,
					recipient: `${recipient.amount}`,
				},
				after: { holder: observed },
				txHash: reading.txHash,
				ledger: reading.ledger,
			},
		);
	},
};
