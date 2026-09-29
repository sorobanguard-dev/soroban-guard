import { describe, expect, it } from "vitest";
import type { SubmitResult } from "../../../src/core/invoke.ts";
import {
	assertDeltas,
	writeEvidence,
} from "../../../src/sep41/checks/delta.ts";
import type { CheckMeta } from "../../../src/sep41/checks/shared.ts";

/**
 * delta.ts is the pure half of a write check: given numbers, decide a
 * verdict. No RPC, no stubs, no ledger — so every branch is cheap to pin,
 * and the arithmetic that decides whether a token is accused of losing
 * value is settled here rather than on testnet.
 */

const META = {
	id: "sep41-transfer",
	clause: "SEP-41 §transfer",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const APPLIED = {
	kind: "applied",
	txHash: "a6eecb",
	ledger: 4738627,
} as const satisfies Extract<SubmitResult, { kind: "applied" }>;

const EXPECTED = "transfer moves the amount from holder to recipient";

describe("assertDeltas", () => {
	it("PASSes when every expectation is met exactly", () => {
		const result = assertDeltas(
			META,
			EXPECTED,
			[
				{ label: "holder", before: 100n, after: 99n },
				{ label: "recipient", before: 5n, after: 6n },
			],
			[
				{ label: "holder", delta: -1n },
				{ label: "recipient", delta: 1n },
			],
			{},
			0,
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toBe("holder -1, recipient +1");
	});

	it("FAILs and names the mismatch when value does not arrive", () => {
		const result = assertDeltas(
			META,
			EXPECTED,
			[
				{ label: "holder", before: 100n, after: 99n },
				{ label: "recipient", before: 5n, after: 5n },
			],
			[
				{ label: "holder", delta: -1n },
				{ label: "recipient", delta: 1n },
			],
			{},
			0,
		);
		expect(result.status).toBe("FAIL");
		// The holder half was correct, so only the recipient is reported.
		expect(result.actual).toBe("recipient 0, expected +1");
	});

	it("reports every mismatch, not just the first", () => {
		const result = assertDeltas(
			META,
			EXPECTED,
			[
				{ label: "holder", before: 100n, after: 90n },
				{ label: "recipient", before: 5n, after: 20n },
			],
			[
				{ label: "holder", delta: -1n },
				{ label: "recipient", delta: 1n },
			],
			{},
			0,
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("holder -10");
		expect(result.actual).toContain("recipient +15");
	});

	// A fee-on-transfer token debits more than it credits. SEP-41 gives
	// transfer no fee semantics, so exactness is the point: this must FAIL
	// rather than be tolerated.
	it("FAILs a fee-on-transfer token rather than tolerating the shortfall", () => {
		const result = assertDeltas(
			META,
			EXPECTED,
			[
				{ label: "holder", before: 1000n, after: 900n },
				{ label: "recipient", before: 0n, after: 95n },
			],
			[
				{ label: "holder", delta: -100n },
				{ label: "recipient", delta: 100n },
			],
			{},
			0,
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("recipient +95, expected +100");
	});

	it("FAILs when an expected quantity was never observed", () => {
		const result = assertDeltas(
			META,
			EXPECTED,
			[{ label: "holder", before: 100n, after: 99n }],
			[
				{ label: "holder", delta: -1n },
				{ label: "recipient", delta: 1n },
			],
			{},
			0,
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("recipient was not observed");
	});

	it("carries the check's identity and the measured duration", () => {
		const result = assertDeltas(
			META,
			EXPECTED,
			[{ label: "holder", before: 1n, after: 0n }],
			[{ label: "holder", delta: -1n }],
			{ txHash: "x" },
			4200,
		);
		expect(result.id).toBe("sep41-transfer");
		expect(result.clause).toBe("SEP-41 §transfer");
		expect(result.layer).toBe("behavior");
		expect(result.durationMs).toBe(4200);
		expect(result.evidence).toEqual({ txHash: "x" });
	});

	// A verdict requiring nothing would PASS without examining anything —
	// the one way this function could bless a contract it never checked.
	it("refuses to judge with no expectations rather than PASSing vacuously", () => {
		expect(() => assertDeltas(META, EXPECTED, [], [], {}, 0)).toThrow(
			RangeError,
		);
	});

	/**
	 * `paysFees` exists for one situation: the asset under test is also the
	 * asset transaction fees are paid in — the native XLM Stellar Asset
	 * Contract — so a party that signed the call is debited by the network
	 * as well as by the contract, and the two cannot be separated from a
	 * balance delta alone.
	 *
	 * The rules it has to obey are narrow, and each is pinned below: only a
	 * shortfall is excusable, only for the signer, and never over a real
	 * mismatch elsewhere.
	 */
	describe("a party that also paid the fee in this asset", () => {
		it("is UNVERIFIABLE when short by more than the clause requires", () => {
			const result = assertDeltas(
				META,
				EXPECTED,
				[
					{ label: "holder", before: 100000n, after: 86185n },
					{ label: "recipient", before: 5n, after: 6n },
				],
				[
					{ label: "holder", delta: -1n, paysFees: true },
					{ label: "recipient", delta: 1n },
				],
				{},
				0,
			);
			expect(result.status).toBe("UNVERIFIABLE");
			expect(result.actual).toContain("transaction fee");
		});

		// A fee is always a debit, so a signer holding *more* than expected
		// cannot be explained by one. That is the contract inventing value.
		it("still FAILs a signer that gained rather than paid", () => {
			const result = assertDeltas(
				META,
				EXPECTED,
				[{ label: "holder", before: 100n, after: 150n }],
				[{ label: "holder", delta: -1n, paysFees: true }],
				{},
				0,
			);
			expect(result.status).toBe("FAIL");
			expect(result.actual).toContain("expected -1");
		});

		// The protection that makes the excuse safe: a fee-on-transfer token
		// also over-debits the signer, but short-changes the counterparty
		// doing it. That mismatch outranks the unreadable side.
		it("FAILs when another party mismatched, fee or not", () => {
			const result = assertDeltas(
				META,
				EXPECTED,
				[
					{ label: "holder", before: 100000n, after: 86185n },
					{ label: "recipient", before: 5n, after: 5n },
				],
				[
					{ label: "holder", delta: -1n, paysFees: true },
					{ label: "recipient", delta: 1n },
				],
				{},
				0,
			);
			expect(result.status).toBe("FAIL");
			expect(result.actual).toContain("recipient 0");
			expect(result.actual).not.toContain("transaction fee");
		});

		// And the ordinary case is untouched: an exact match still PASSes,
		// so marking a party as a fee payer costs nothing on every token
		// whose fees are paid in a different asset.
		it("PASSes an exact delta even when marked as a fee payer", () => {
			const result = assertDeltas(
				META,
				EXPECTED,
				[{ label: "holder", before: 100n, after: 99n }],
				[{ label: "holder", delta: -1n, paysFees: true }],
				{},
				0,
			);
			expect(result.status).toBe("PASS");
		});
	});
});

describe("writeEvidence", () => {
	it("renders balances as strings and carries the transaction handle", () => {
		const evidence = writeEvidence(
			APPLIED,
			{ owner: 100n, spender: 5n },
			{ owner: 99n, spender: 6n },
		);
		expect(evidence).toEqual({
			before: { owner: "100", spender: "5" },
			after: { owner: "99", spender: "6" },
			txHash: "a6eecb",
			ledger: 4738627,
		});
	});

	it("omits `after` entirely when the post-state was not read", () => {
		const evidence = writeEvidence(APPLIED, { owner: 100n, spender: 5n });
		expect(evidence.after).toBeUndefined();
		expect("after" in evidence).toBe(false);
		expect(evidence.before).toEqual({ owner: "100", spender: "5" });
	});

	// i128 exceeds what a JS number represents exactly. Round-tripping
	// through Number would silently corrupt a large balance, so the
	// rendering must stay in bigint all the way to the string.
	it("renders i128-scale balances without precision loss", () => {
		const huge = 170141183460469231731687303715884105727n;
		const evidence = writeEvidence(APPLIED, { owner: huge });
		expect(evidence.before.owner).toBe(
			"170141183460469231731687303715884105727",
		);
	});
});
