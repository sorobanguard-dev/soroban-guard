import { afterEach, describe, expect, it, vi } from "vitest";
import { overBalanceTransferCheck } from "../../../src/sep41/checks/over-balance.ts";
import {
	APPLIED,
	okResponse,
	rejected,
	sequencedServer,
	stubSubmit,
	writeCtx,
} from "../fixtures.ts";

/**
 * How many reads the check spends, asserted exactly.
 *
 * `sequencedServer` throws once exhausted, so an unplanned read already
 * fails a test — but nothing pins the *opposite* mistake: a check that
 * silently stopped reading would still pass every verdict assertion while
 * quietly dropping the evidence a reviewer needs. These state the count so
 * either direction is a finding.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

describe("overBalanceTransferCheck reads", () => {
	// Two reads before the submit — the holder's balance to exceed, and the
	// recipient's to prove it is not the issuer — and none after: a refusal
	// changed nothing, so re-reading would spend a round trip to learn what
	// the check already knows.
	it("reads both balances and no more when the contract refuses", async () => {
		stubSubmit(rejected("HostError: Error(Contract, #2)"));
		const server = sequencedServer([okResponse(100n), okResponse(5n)]);
		const spy = vi.spyOn(server, "simulateTransaction");
		const result = await overBalanceTransferCheck.run(writeCtx(server));
		expect(result.status).toBe("PASS");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	// A success is the finding, and then the after-balance says which bug it
	// was — a silent mint or a wrapped subtraction. Worth the third read.
	it("reads again only when the transfer went through", async () => {
		stubSubmit(APPLIED);
		const server = sequencedServer([
			okResponse(100n),
			okResponse(5n),
			okResponse(0n),
		]);
		const spy = vi.spyOn(server, "simulateTransaction");
		const result = await overBalanceTransferCheck.run(writeCtx(server));
		expect(result.status).toBe("FAIL");
		expect(spy).toHaveBeenCalledTimes(3);
	});
});
