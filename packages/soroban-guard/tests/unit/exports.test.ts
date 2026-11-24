import { describe, expect, it } from "vitest";
import * as invoke from "../../src/core/invoke.ts";
import * as pkg from "../../src/index.ts";

/**
 * What the package publishes from the invocation module. Settling a sent
 * transaction is internal, so changing it never breaks a consumer, and
 * `isContractOutcome`, exported in 0.4.5, is gone: message text is not
 * evidence of a refusal.
 */
describe("package exports from core/invoke", () => {
	const published = Object.keys(invoke).filter((name) => name in pkg);

	it("publishes exactly the invocation API", () => {
		expect(published.sort()).toEqual([
			"I128_MAX",
			"addressArg",
			"amountArg",
			"interpretSimulation",
			"ledgerArg",
			"simulateRead",
			"submitWrite",
		]);
	});

	it.each([
		"sendAndFollow",
		"lookupOutcome",
		"mayHaveExpired",
		"RPC_TIMEOUT_MS",
		"isContractOutcome",
		"classifySimulationFailure",
	])("does not publish %s", (name) => {
		expect(name in pkg).toBe(false);
	});
});
