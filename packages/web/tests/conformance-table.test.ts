import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CHECK_REFERENCE } from "../src/data/check-reference.ts";
import {
	CONFORMANCE_RUNS,
	fromReport,
	RUN_ORDER,
} from "../src/data/conformance-table.ts";
import set from "../src/data/results/set.json";

/**
 * The /results table publishes verdicts about named contracts, so a wrong
 * cell is a false public claim. The table is read from committed CLI
 * reports; these pin it to the check set the site documents, and prove
 * the loader refuses a report it could misstate.
 */
const COLUMN = {
	name: "set",
	label: "SET",
	contractId: set.contractId,
	origin: "test",
};

describe("conformance table", () => {
	it("runs exactly the checks the reference documents, once each", () => {
		const documented = CHECK_REFERENCE.groups.flatMap((group) =>
			group.checks.map((check) => check.id),
		);
		expect(new Set(RUN_ORDER).size).toBe(RUN_ORDER.length);
		expect([...RUN_ORDER].sort()).toEqual([...documented].sort());
	});

	it.each(CONFORMANCE_RUNS.map((run) => [run.name, run] as const))(
		"%s has a verdict for every check",
		(_name, run) => {
			expect(Object.keys(run.cells).sort()).toEqual([...RUN_ORDER].sort());
		},
	);

	// A PASS on a write is only checkable if it names its transaction.
	it.each(CONFORMANCE_RUNS.map((run) => [run.name, run] as const))(
		"%s links every settled write to its transaction",
		(_name, run) => {
			for (const id of ["sep41-transfer", "sep41-approve", "sep41-burn"]) {
				const cell = run.cells[id];
				if (cell?.status === "PASS") {
					expect(cell.txHash).toMatch(/^[0-9a-f]{64}$/);
				}
			}
		},
	);

	it("names real, distinct contract ids", () => {
		const ids = CONFORMANCE_RUNS.map((run) => run.contractId);
		expect(ids.every((id) => StrKey.isValidContract(id))).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("fromReport refuses a report it could misstate", () => {
	it("a report for a different contract", () => {
		expect(() =>
			fromReport(
				{
					...COLUMN,
					contractId:
						"CC2LCJBERJPDTD27FGLYDTWAGSKEAJN42VT6SNQPVTEGQV63ZHKBSA5H",
				},
				set,
			),
		).toThrow(/is a report for/);
	});

	it("a missing check", () => {
		const short = { ...set, results: set.results.slice(1) };
		expect(() => fromReport(COLUMN, short)).toThrow(/missing sep41-decimals/);
	});

	it("a duplicated check", () => {
		const doubled = {
			...set,
			results: [...set.results, set.results[0] as (typeof set.results)[0]],
		};
		expect(() => fromReport(COLUMN, doubled)).toThrow(/twice/);
	});

	it("a summary that disagrees with its rows", () => {
		const lying = { ...set, summary: { ...set.summary, pass: 0 } };
		expect(() => fromReport(COLUMN, lying)).toThrow(
			/summary that disagrees with its own rows/,
		);
	});
});
