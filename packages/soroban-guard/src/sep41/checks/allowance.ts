/**
 * SEP-41 §allowance — how much a spender may move on an owner's behalf.
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

const allowanceMeta = {
	id: "sep41-allowance",
	clause: "SEP-41 §allowance",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED = "non-negative allowance from owner to spender";

export const allowanceCheck: Check<Sep41Context> = {
	...allowanceMeta,
	description: "allowance() returns a non-negative spend approval",
	async run(ctx) {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "allowance")) {
			return notImplemented(allowanceMeta, "allowance", elapsed());
		}
		const { owner, spender } = ctx.parties;
		const { outcome, ledger } = await callRead(ctx, "allowance", [
			addressArg(owner.address),
			addressArg(spender.address),
		]);
		if (outcome.kind === "trapped") {
			const reason = noStanding(outcome);
			if (reason !== null) {
				return noStandingTrap(
					allowanceMeta,
					EXPECTED,
					ledger,
					reason,
					outcome.diagnostics,
					elapsed(),
				);
			}
		}
		return mapReadOutcome(
			allowanceMeta,
			EXPECTED,
			"scvI128",
			ledger,
			outcome,
			(value) => {
				if (typeof value !== "bigint" || value < 0n) {
					return null;
				}
				// Either side being generated is enough: an allowance is a
				// relationship, and two addresses that never interacted read 0
				// whether the contract tracks allowances or ignores them
				// entirely. Same reasoning as balance's zero case, applied to
				// the pair rather than to one holder.
				if (value === 0n && (owner.isThrowaway || spender.isThrowaway)) {
					return {
						verdict: "unverifiable",
						actual:
							"allowance is 0 between addresses that never interacted; set OWNER_ADDRESS and SPENDER_ADDRESS to a real approving pair",
					} as const;
				}
				return { verdict: "pass", actual: `allowance is ${value}` } as const;
			},
			elapsed(),
		);
	},
};
