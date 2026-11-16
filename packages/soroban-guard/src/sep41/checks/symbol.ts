/**
 * SEP-41 §symbol — the token's ticker symbol.
 */
import type { Check } from "../../core/types.ts";
import type { Sep41Context } from "../context.ts";
import { mapReadOutcome } from "./read-outcome.ts";
import {
	type CheckMeta,
	callRead,
	isDeclared,
	notImplemented,
} from "./shared.ts";

const symbolMeta = {
	id: "sep41-symbol",
	clause: "SEP-41 §symbol",
	layer: "interface",
	requirement: "required",
} as const satisfies CheckMeta;

export const symbolCheck: Check<Sep41Context> = {
	...symbolMeta,
	description: "symbol() returns the token's ticker symbol",
	async run(ctx) {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "symbol")) {
			return notImplemented(symbolMeta, "symbol", elapsed());
		}
		const { outcome, ledger } = await callRead(ctx, "symbol", []);
		return mapReadOutcome(
			symbolMeta,
			"string token symbol",
			"scvString",
			ledger,
			outcome,
			// Spec-legal when empty — see name.ts for the reasoning. Reported
			// rather than accused.
			(value) => {
				if (typeof value !== "string") {
					return null;
				}
				return {
					verdict: "pass",
					actual:
						value.trim() === ""
							? `symbol is ${JSON.stringify(value)} (empty; nothing for a wallet to display)`
							: `symbol is ${JSON.stringify(value)}`,
				} as const;
			},
			elapsed(),
		);
	},
};
