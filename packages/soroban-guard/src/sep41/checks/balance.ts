/**
 * SEP-41 §balance — what an address holds.
 */
import { addressArg } from "../../core/invoke.ts";
import type { Check } from "../../core/types.ts";
import type { Sep41Context } from "../context.ts";
import { mapReadOutcome, noStanding, noStandingTrap } from "./read-outcome.ts";
import {
	type CheckMeta,
	callRead,
	isDeclared,
	notImplemented,
} from "./shared.ts";

const balanceMeta = {
	id: "sep41-balance",
	clause: "SEP-41 §balance",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED = "non-negative balance for the holder";

export const balanceCheck: Check<Sep41Context> = {
	...balanceMeta,
	description: "balance() returns a non-negative holding for an address",
	async run(ctx) {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "balance")) {
			return notImplemented(balanceMeta, "balance", elapsed());
		}
		const owner = ctx.parties.owner;
		const { outcome, ledger } = await callRead(ctx, "balance", [
			addressArg(owner.address),
		]);
		if (outcome.kind === "trapped") {
			const reason = noStanding(outcome);
			if (reason !== null) {
				return noStandingTrap(
					balanceMeta,
					EXPECTED,
					ledger,
					reason,
					outcome.diagnostics,
					elapsed(),
				);
			}
		}
		return mapReadOutcome(
			balanceMeta,
			EXPECTED,
			"scvI128",
			ledger,
			outcome,
			(value) => {
				if (typeof value !== "bigint" || value < 0n) {
					return null;
				}
				// Only zero. A generated probe holds nothing, so 0 is exactly
				// what an always-zero bug, an empty-state default and a
				// correct answer all return — it distinguishes nothing. Any
				// other value does distinguish: it rules out always-zero and
				// always-trap, and the message states what was returned
				// without claiming the probe is a holder.
				if (value === 0n && owner.isThrowaway) {
					return {
						verdict: "unverifiable",
						actual:
							"balance is 0 on a generated probe address; set OWNER_ADDRESS for a real assertion",
					} as const;
				}
				return { verdict: "pass", actual: `balance is ${value}` } as const;
			},
			elapsed(),
		);
	},
};
