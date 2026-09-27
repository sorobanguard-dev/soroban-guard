import { describe, expect, it } from "vitest";
import type { SubmitResult } from "../../../src/core/invoke.ts";
import {
	inconclusiveResult,
	type RefusalReading,
	readRefusal,
} from "../../../src/sep41/checks/refusal.ts";

/**
 * Offline coverage for the refusal ladder both directions use.
 *
 * The ordering is the safety property: every unattributable outcome is
 * classified before the refusal that would PASS, so nothing ambiguous can
 * fall through into a verdict. The throw at the end is the backstop — it
 * exists to fire when a sixth SubmitResult kind appears, and this file is
 * where that firing is pinned rather than left to a live run.
 */

const WORDING = {
	attempt: "the attempt",
	rule: "the rule",
} as const;

function reading(result: SubmitResult): RefusalReading {
	return readRefusal(result, WORDING);
}

describe("readRefusal", () => {
	it("credits a contract refusal as refused", () => {
		expect(
			reading({ kind: "rejected", diagnostics: "HostError", settled: false }),
		).toEqual({ kind: "refused", diagnostics: "HostError" });
	});

	it("reports an applied attempt as allowed, never as refused", () => {
		expect(reading({ kind: "applied", txHash: "abc123", ledger: 1 })).toEqual({
			kind: "allowed",
			txHash: "abc123",
			ledger: 1,
		});
	});

	it("reports a timeout as inconclusive with its hash", () => {
		expect(reading({ kind: "timeout", txHash: "abc123" })).toEqual({
			kind: "inconclusive",
			actual: expect.stringContaining("abc123"),
			txHash: "abc123",
		});
	});

	it("reports a hashless timeout as inconclusive with no evidence", () => {
		const result = reading({ kind: "timeout", txHash: "" });
		expect(result.kind).toBe("inconclusive");
		if (result.kind === "inconclusive") {
			// An empty hash is not a hash: carrying "" through would put a
			// txHash key in the evidence that no explorer can resolve.
			expect(result.txHash).toBeUndefined();
			expect(result.actual).toContain("no transaction hash was observed");
			expect(result.actual).not.toContain("stopped waiting on");
		}
	});

	it("reports archived state as inconclusive, not as refused", () => {
		const result = reading({ kind: "restore", diagnostics: "archived" });
		expect(result.kind).toBe("inconclusive");
	});

	it("reports a ledger failure as inconclusive even with a hash", () => {
		const result = reading({
			kind: "rejected",
			diagnostics: "failed on-chain",
			settled: true,
			txHash: "abc123",
			ledger: 1,
		});
		expect(result.kind).toBe("inconclusive");
		if (result.kind === "inconclusive") {
			expect(result.txHash).toBe("abc123");
			expect(result.ledger).toBe(1);
		}
	});

	it("reports a trustline refusal as inconclusive, not as enforcement", () => {
		const result = reading({
			kind: "rejected",
			diagnostics: "trustline entry is missing for account G...",
			settled: false,
		});
		expect(result.kind).toBe("inconclusive");
	});

	// classifyStanding has two arms and only the first was exercised above.
	// A deauthorized trustline is the asset freezing the account, which is
	// the issuer's policy rather than the contract's rule — crediting it
	// would claim evidence of a check the contract may never perform.
	it("reports a deauthorized balance as inconclusive, not as enforcement", () => {
		const result = reading({
			kind: "rejected",
			diagnostics: "balance is deauthorized for account G...",
			settled: false,
		});
		expect(result.kind).toBe("inconclusive");
		if (result.kind === "inconclusive") {
			expect(result.actual).toContain("trustline policy");
		}
	});

	it("carries a settled failure's ledger through to the reading", () => {
		const result = reading({
			kind: "rejected",
			diagnostics: "tx_insufficient_fee",
			settled: true,
			txHash: "abc123",
			ledger: 42,
		});
		expect(result.kind).toBe("inconclusive");
		if (result.kind === "inconclusive") {
			expect(result.ledger).toBe(42);
		}
	});

	it("throws on an unknown submission kind rather than certifying it", () => {
		expect(() =>
			reading({
				kind: "settled-ish",
				txHash: "abc123",
			} as unknown as SubmitResult),
		).toThrow(/unhandled submission kind/);
	});
});

/**
 * The sibling of `setupEvidence`, which shared.test.ts pins the same way.
 * An absent field has to be an absent key: `{ txHash: undefined }` renders
 * as an evidence line with nothing after the colon, which reads as a lost
 * hash rather than as one that never existed.
 */
describe("inconclusiveResult", () => {
	const META = {
		id: "sep41-transfer-over-balance",
		clause: "transfer",
		layer: "behavior",
		requirement: "required",
	} as const;

	it("omits evidence keys that the reading did not carry", () => {
		const result = inconclusiveResult(
			{ kind: "inconclusive", actual: "stopped waiting" },
			META,
			"a refusal",
			5,
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.evidence).toEqual({});
		expect(Object.keys(result.evidence ?? {})).toHaveLength(0);
	});

	it("keeps every key the reading did carry", () => {
		const result = inconclusiveResult(
			{
				kind: "inconclusive",
				actual: "failed on-chain",
				diagnostics: "tx_insufficient_fee",
				txHash: "abc123",
				ledger: 42,
			},
			META,
			"a refusal",
			5,
		);
		expect(result.evidence).toEqual({
			error: "tx_insufficient_fee",
			txHash: "abc123",
			ledger: 42,
		});
	});
});
