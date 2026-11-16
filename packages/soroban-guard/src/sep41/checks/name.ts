/**
 * SEP-41 §name — the token's human-readable name.
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

const nameMeta = {
	id: "sep41-name",
	clause: "SEP-41 §name",
	layer: "interface",
	requirement: "required",
} as const satisfies CheckMeta;

export const nameCheck: Check<Sep41Context> = {
	...nameMeta,
	description: "name() returns the token's human-readable name",
	async run(ctx) {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "name")) {
			return notImplemented(nameMeta, "name", elapsed());
		}
		const { outcome, ledger } = await callRead(ctx, "name", []);
		return mapReadOutcome(
			nameMeta,
			"string token name",
			"scvString",
			ledger,
			outcome,
			// SEP-41 declares `name() -> String` and constrains the content no
			// further, so an empty or blank name is spec-legal and FAILing it
			// would accuse a conformant contract. It is still worth seeing —
			// wallets and explorers have nothing to display — so it passes
			// with the anomaly in the message, the same treatment decimals
			// gives an out-of-range but legal value.
			(value) => {
				if (typeof value !== "string") {
					return null;
				}
				return {
					verdict: "pass",
					actual:
						value.trim() === ""
							? `name is ${JSON.stringify(value)} (empty; nothing for a wallet to display)`
							: `name is ${JSON.stringify(value)}`,
				} as const;
			},
			elapsed(),
		);
	},
};
