import { describe, expect, it } from "vitest";
import type { CheckResult } from "../../../src/core/types.ts";
import {
	SEP41_MEMBERS,
	sep41Suite,
	withCoverageGaps,
} from "../../../src/sep41/index.ts";

function assessed(id: string): CheckResult {
	return {
		id,
		clause: `SEP-41 §${id}`,
		layer: "behavior",
		requirement: "required",
		status: "PASS",
		expected: "stub",
		actual: "stub",
		evidence: {},
		durationMs: 0,
	};
}

describe("SEP41_MEMBERS", () => {
	it("lists the ten required token-interface members", () => {
		expect([...SEP41_MEMBERS].sort()).toEqual(
			[
				"allowance",
				"approve",
				"balance",
				"burn",
				"burn_from",
				"decimals",
				"name",
				"symbol",
				"transfer",
				"transfer_from",
			].sort(),
		);
	});
});

describe("suite coverage convention", () => {
	// An id is `sep41-<member>`, optionally with a `-suffix` naming a
	// variant of that clause. Both forms must resolve to a member, or the
	// check opens a phantom gap row beside itself.
	it("every check id resolves to a member of SEP41_MEMBERS", () => {
		expect(sep41Suite.checks.length).toBeGreaterThan(0);
		for (const check of sep41Suite.checks) {
			expect(check.id.startsWith("sep41-")).toBe(true);
			const rest = check.id.slice("sep41-".length);
			const member = SEP41_MEMBERS.find(
				(m) => rest === m || rest.startsWith(`${m}-`),
			);
			expect(member, `${check.id} names no member`).toBeDefined();
		}
	});

	// burn is a prefix of burn_from, so a shortest-first match would credit
	// a burn_from check to burn and leave burn_from looking unassessed.
	it("attributes a variant id to its longest matching member", () => {
		const results = withCoverageGaps([
			{
				id: "sep41-burn_from-unauthorized",
				clause: "SEP-41 §burn_from",
				layer: "behavior",
				requirement: "required",
				status: "PASS",
				expected: "x",
				actual: "y",
				evidence: {},
				durationMs: 0,
			},
		]);
		const gaps = results.filter(
			(r) => r.actual === "not assessed by this suite",
		);
		expect(gaps.map((r) => r.id)).not.toContain("sep41-burn_from");
		expect(gaps.map((r) => r.id)).toContain("sep41-burn");
	});
});

describe("withCoverageGaps", () => {
	it("emits UNVERIFIABLE rows for unassessed members", () => {
		const results = withCoverageGaps([]);
		expect(results).toHaveLength(10);
		for (const result of results) {
			expect(result.status).toBe("UNVERIFIABLE");
			expect(result.actual).toBe("not assessed by this suite");
			expect(result.requirement).toBe("required");
		}
		expect(results.map((result) => result.id).sort()).toEqual(
			[...SEP41_MEMBERS].map((member) => `sep41-${member}`).sort(),
		);
	});

	it("leaves fully covered results untouched", () => {
		const full = SEP41_MEMBERS.map((member) => assessed(`sep41-${member}`));
		const results = withCoverageGaps(full);
		expect(results).toHaveLength(10);
		expect(results.every((result) => result.status === "PASS")).toBe(true);
	});

	it("gaps only what is missing, preserving order", () => {
		const partial = [assessed("sep41-decimals"), assessed("sep41-balance")];
		const results = withCoverageGaps(partial);
		expect(results).toHaveLength(10);
		expect(results.slice(0, 2).map((result) => result.id)).toEqual([
			"sep41-decimals",
			"sep41-balance",
		]);
		expect(
			results.slice(2).every((result) => result.status === "UNVERIFIABLE"),
		).toBe(true);
	});

	it("ignores ids outside the convention without inventing rows", () => {
		const results = withCoverageGaps([assessed("something-else")]);
		expect(results).toHaveLength(11);
		expect(results[0]?.id).toBe("something-else");
	});
});

/**
 * Order is a safety property here, not presentation.
 *
 * Every rule below exists because breaking it silently degrades a verdict
 * against a *broken* contract — which is the only time a verdict matters
 * and the case no other test covers, since each check is unit-tested alone
 * against a fresh fixture. The reasoning lives in index.ts; this is what
 * stops an innocent-looking reshuffle from undoing it.
 */
describe("sep41Suite ordering", () => {
	const ids = sep41Suite.checks.map((check) => check.id);
	const at = (id: string) => {
		const index = ids.indexOf(id);
		expect(index, `${id} is not in the suite`).toBeGreaterThanOrEqual(0);
		return index;
	};

	it("reads before writes", () => {
		for (const read of ["decimals", "balance", "allowance", "name", "symbol"]) {
			expect(at(`sep41-${read}`)).toBeLessThan(at("sep41-transfer"));
		}
	});

	it("tests the unauthorized spend before approve grants one", () => {
		// Its premise is an absence: approve would create the very allowance
		// it needs missing.
		expect(at("sep41-transfer_from-unauthorized")).toBeLessThan(
			at("sep41-approve"),
		);
	});

	it("runs the refusal checks before the writes that would starve them", () => {
		// A holder drained to zero makes `balance + 1` equal 1, which a
		// contract may refuse for having nothing rather than for checking a
		// floor.
		for (const refusal of [
			"sep41-transfer-zero-amount",
			"sep41-transfer-self",
			"sep41-transfer-negative-amount",
			"sep41-transfer-over-balance",
		]) {
			expect(at(refusal)).toBeLessThan(at("sep41-transfer"));
		}
	});

	it("orders the refusal checks least-destructive first", () => {
		// What a refusal check leaves behind when the contract ignores it:
		// zero and self move nothing whatever the arithmetic does, a negative
		// amount shifts one unit, and `balance + 1` takes everything and
		// drives the holder below zero. Reversing the last pair is the
		// regression that turns one finding into one finding plus eight
		// unverifiables.
		expect(at("sep41-transfer-zero-amount")).toBeLessThan(
			at("sep41-transfer-negative-amount"),
		);
		expect(at("sep41-transfer-self")).toBeLessThan(
			at("sep41-transfer-negative-amount"),
		);
		expect(at("sep41-transfer-negative-amount")).toBeLessThan(
			at("sep41-transfer-over-balance"),
		);
	});

	it("leaves the wall-clock wait last", () => {
		// It waits ~10s for a ledger to pass; anything behind it waits too.
		expect(at("sep41-transfer_from-expired")).toBe(ids.length - 1);
	});
});
