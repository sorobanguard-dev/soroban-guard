/**
 * SEP-41 §burn — destroy the holder's own tokens.
 *
 * What cannot be checked here: that supply actually fell. SEP-41 declares no
 * `total_supply`, so a contract that debited the holder and quietly minted
 * the same amount elsewhere is indistinguishable from one that burned. The
 * holder's debit is the whole observable, and this check claims no more.
 *
 * Unlike transfer, this destroys value that cannot be recovered — so the
 * amount is one unit and the guards that protect the operator apply with
 * more force, not less.
 *
 * Non-atomic, as transfer's header describes: read, submit, read spans
 * separate ledger states with no snapshot read available. Other activity on
 * the holder in that window shifts a balance this check did not move, and
 * the exact-delta assertion reads it as the contract destroying the wrong
 * amount. Use addresses dedicated to the run.
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

/** One unit: the smallest irreversible amount that still proves the debit. */
const BURN_AMOUNT = 1n;

const burnMeta = {
	id: "sep41-burn",
	clause: "SEP-41 §burn",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED = "burn removes the amount from the holder's balance";

const { unverifiable } = verdictHelpers(burnMeta, EXPECTED);

export const burnCheck = {
	...burnMeta,
	description: "burn() removes the amount from the holder's balance",
	async run(ctx: Sep41Context): Promise<CheckResult> {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "burn")) {
			return notImplemented(burnMeta, "burn", elapsed());
		}

		const { owner } = ctx.parties;
		if (owner.signer === undefined) {
			return unverifiable(
				"no signing authority for the holder; set OWNER_SECRET to an account that both signs and holds this token",
				elapsed(),
			);
		}
		if (owner.signer.address !== owner.address) {
			return unverifiable(
				`the holder is ${owner.address} but the signer signs as ${owner.signer.address}; supply a signer for the holder`,
				elapsed(),
			);
		}

		const before = await readBalance(ctx, owner.address);
		if (before.kind === "defect") {
			return {
				...burnMeta,
				status: "FAIL",
				expected: EXPECTED,
				actual: `${before.detail}; the before state cannot be trusted`,
				evidence: before.error === "" ? {} : { error: before.error },
				durationMs: elapsed(),
			};
		}
		if (before.kind !== "value") {
			return unverifiable(
				"balance unreadable; cannot establish a before state to compare against",
				elapsed(),
			);
		}
		if (before.amount < BURN_AMOUNT) {
			return unverifiable(
				`holder has ${before.amount}, nothing to burn`,
				elapsed(),
			);
		}
		// An issuer's balance is the i64::MAX sentinel and does not decrease,
		// so the delta would read as the burn having done nothing.
		if (before.amount === ISSUER_SENTINEL_BALANCE) {
			return unverifiable(
				"holder is the asset issuer (balance reads i64::MAX); burning from an issuer does not decrease it, so the delta proves nothing — point OWNER_SECRET at a holding account",
				elapsed(),
			);
		}

		const submitted = await submitWrite(
			ctx.server,
			{
				contractId: ctx.contractId,
				method: "burn",
				args: [addressArg(owner.address), amountArg(BURN_AMOUNT)],
				signer: owner.signer,
			},
			ctx.networkPassphrase,
		);

		if (submitted.kind === "timeout") {
			return {
				...burnMeta,
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
			const standing = classifyStanding(submitted.diagnostics);
			if (standing !== null) {
				return unverifiable(
					"the burn was refused by the asset's own trustline policy, not by a defect in the contract",
					elapsed(),
					submitted.diagnostics,
				);
			}
			return {
				...burnMeta,
				status: "FAIL",
				expected: EXPECTED,
				actual:
					"a burn of an affordable amount, signed by the holder, was refused",
				evidence: { error: submitted.diagnostics },
				durationMs: elapsed(),
			};
		}

		const holderBefore = { holder: before.amount };
		let after: QuantityRead;
		try {
			after = await readBalance(ctx, owner.address);
		} catch (error) {
			return {
				...burnMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual: "burn applied, but reading the balance afterwards failed",
				evidence: {
					...writeEvidence(submitted, holderBefore),
					error: error instanceof Error ? error.message : String(error),
				},
				durationMs: elapsed(),
			};
		}
		if (after.kind === "defect") {
			return {
				...burnMeta,
				status: "FAIL",
				expected: EXPECTED,
				actual: `burn applied, then ${after.detail}`,
				evidence: {
					...writeEvidence(submitted, holderBefore),
					...(after.error === "" ? {} : { error: after.error }),
				},
				durationMs: elapsed(),
			};
		}
		if (after.kind !== "value") {
			return {
				...burnMeta,
				status: "UNVERIFIABLE",
				expected: EXPECTED,
				actual: "burn applied but the balance was unreadable afterwards",
				evidence: writeEvidence(submitted, holderBefore),
				durationMs: elapsed(),
			};
		}

		return assertDeltas(
			burnMeta,
			EXPECTED,
			[{ label: "holder", before: before.amount, after: after.amount }],
			[{ label: "holder", delta: -BURN_AMOUNT }],
			writeEvidence(submitted, holderBefore, { holder: after.amount }),
			elapsed(),
		);
	},
};
