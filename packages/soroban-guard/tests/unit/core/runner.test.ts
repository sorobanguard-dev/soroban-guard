import { describe, expect, it } from "vitest";
import { type CheckProgress, runSuite } from "../../../src/core/runner.ts";
import type { Check, CheckResult, Suite } from "../../../src/core/types.ts";

function stubCheck(
	id: string,
	outcome: CheckResult | Error | unknown,
): Check<unknown> {
	return {
		id,
		clause: "TEST §example",
		layer: "behavior",
		requirement: "required",
		description: `stub ${id}`,
		run: async () => {
			if (outcome instanceof Error || typeof outcome === "string") {
				throw outcome;
			}
			return outcome as CheckResult;
		},
	};
}

function passResult(id: string): CheckResult {
	return {
		id,
		clause: "TEST §example",
		layer: "behavior",
		requirement: "required",
		status: "PASS",
		expected: "stub passes",
		actual: "stub passed",
		evidence: {},
		durationMs: 1,
	};
}

describe("runSuite", () => {
	it("reports each check starting and finishing, including a throw", async () => {
		const suite: Suite<unknown> = {
			standard: "TEST",
			checks: [
				stubCheck("first", passResult("first")),
				stubCheck("broken", new Error("RPC down")),
			],
		};
		const events: CheckProgress[] = [];
		const [first, broken] = await runSuite(suite, undefined, (event) =>
			events.push(event),
		);
		expect(events).toEqual([
			{ kind: "started", id: "first", completed: 0, total: 2 },
			{ kind: "finished", result: first, completed: 1, total: 2 },
			{ kind: "started", id: "broken", completed: 1, total: 2 },
			{ kind: "finished", result: broken, completed: 2, total: 2 },
		]);
		expect(broken?.status).toBe("SKIPPED");
	});

	it("collects results in order", async () => {
		const first = passResult("first");
		const second = passResult("second");
		const suite: Suite<unknown> = {
			standard: "TEST",
			checks: [stubCheck("first", first), stubCheck("second", second)],
		};
		await expect(runSuite(suite, undefined)).resolves.toEqual([first, second]);
	});

	it("records a throwing check as SKIPPED and continues", async () => {
		const first = passResult("first");
		const last = passResult("last");
		const suite: Suite<unknown> = {
			standard: "TEST",
			checks: [
				stubCheck("first", first),
				stubCheck("broken", new Error("RPC down")),
				stubCheck("last", last),
			],
		};
		const results = await runSuite(suite, undefined);
		expect(results).toHaveLength(3);
		expect(results[0]).toEqual(first);
		expect(results[2]).toEqual(last);
		const recorded = results[1];
		expect(recorded?.status).toBe("SKIPPED");
		expect(recorded?.id).toBe("broken");
		expect(recorded?.expected).toBe("stub broken");
		expect(recorded?.actual).toBe("check did not complete");
		expect(recorded?.evidence.error).toBe("RPC down");
		expect(recorded?.durationMs).toEqual(expect.any(Number));
	});

	it("stringifies non-Error throws", async () => {
		const suite: Suite<unknown> = {
			standard: "TEST",
			checks: [stubCheck("broken", "string failure")],
		};
		const results = await runSuite(suite, undefined);
		expect(results[0]?.status).toBe("SKIPPED");
		expect(results[0]?.evidence.error).toBe("string failure");
	});
});
