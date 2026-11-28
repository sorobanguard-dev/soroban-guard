import { describe, expect, it } from "vitest";
import { validateSignedTestnetReport } from "../../scripts/signed-testnet-report.ts";
import { renderJsonReport } from "../../src/core/json-report.ts";
import type { CheckResult } from "../../src/core/types.ts";
import { sep41Suite } from "../../src/sep41/index.ts";

const CONTRACT = "CAQOHQCN5ZNXFVMTGI7LZFKFBFEKERGTQQ45KR5TGXEE63X6D6L46LQE";
const passingRows = sep41Suite.checks.map(
	({ id, clause, layer, requirement }): CheckResult => ({
		id,
		clause,
		layer,
		requirement,
		status: "PASS",
		expected: "a passing check",
		actual: "the check passed",
		evidence: {},
		durationMs: 0,
	}),
);

function reportFor(results = passingRows) {
	return JSON.parse(
		renderJsonReport({
			standard: sep41Suite.standard,
			contractId: CONTRACT,
			ranAt: "2026-11-28T00:00:00.000Z",
			rpcUrl: "https://soroban-testnet.stellar.org",
			results,
		}),
	);
}

describe("the signed Testnet report gate", () => {
	it("accepts every expected check passing", () => {
		expect(validateSignedTestnetReport(reportFor(), CONTRACT, 0)).toBe(16);
	});

	it("names an extra coverage row and its reason even when there are too many rows", () => {
		const gap: CheckResult = {
			id: "sep41-missing-member",
			clause: "SEP-41 §missing-member",
			layer: "interface",
			requirement: "required",
			status: "UNVERIFIABLE",
			expected: "the member is assessed",
			actual: "not assessed by this suite",
			evidence: {},
			durationMs: 0,
		};
		expect(() =>
			validateSignedTestnetReport(
				reportFor([...passingRows, gap]),
				CONTRACT,
				2,
			),
		).toThrow("sep41-missing-member UNVERIFIABLE — not assessed by this suite");
	});

	it("names a missing check when a duplicate keeps the same row count", () => {
		const duplicate = reportFor([
			...passingRows.filter(({ id }) => id !== "sep41-decimals"),
			...passingRows.filter(({ id }) => id === "sep41-balance"),
		]);
		expect(() => validateSignedTestnetReport(duplicate, CONTRACT, 0)).toThrow(
			"Missing check sep41-decimals",
		);
	});

	it("rejects a mismatched process exit code", () => {
		expect(() => validateSignedTestnetReport(reportFor(), CONTRACT, 2)).toThrow(
			"CLI exit 2 disagrees with report exit 0",
		);
	});

	it("rejects a report from another contract", () => {
		expect(() =>
			validateSignedTestnetReport(reportFor(), "different-contract", 0),
		).toThrow("different contract");
	});
});
