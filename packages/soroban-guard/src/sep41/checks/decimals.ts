/**
 * SEP-41 §decimals — the token's decimal precision.
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

// Sanity bound, not spec: SEP-41 puts no maximum on decimals, and a
// successfully decoded u32 is conclusive by itself (Stellar assets use 7
// or fewer, but the standard allows the full range). Out-of-range values
// therefore PASS with the anomaly visible in the message — never FAIL
// (no accusation on spec-legal values) and never UNVERIFIABLE (the answer
// was observed and decoded).
const MAX_PLAUSIBLE_DECIMALS = 38;

const decimalsMeta = {
	id: "sep41-decimals",
	clause: "SEP-41 §decimals",
	layer: "interface",
	requirement: "required",
} as const satisfies CheckMeta;

export const decimalsCheck: Check<Sep41Context> = {
	...decimalsMeta,
	description: "decimals() returns the token's decimal precision",
	async run(ctx) {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "decimals")) {
			return notImplemented(decimalsMeta, "decimals", elapsed());
		}
		const { outcome, ledger } = await callRead(ctx, "decimals", []);
		return mapReadOutcome(
			decimalsMeta,
			"u32 decimal precision",
			"scvU32",
			ledger,
			outcome,
			(value) => {
				if (
					typeof value !== "number" ||
					!Number.isInteger(value) ||
					value < 0
				) {
					return null;
				}
				if (value <= MAX_PLAUSIBLE_DECIMALS) {
					return { verdict: "pass", actual: `returned ${value}` } as const;
				}
				return {
					verdict: "pass",
					actual: `returned ${value} (outside plausible bounds)`,
				} as const;
			},
			elapsed(),
		);
	},
};
