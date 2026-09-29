import { afterEach, describe, expect, it, vi } from "vitest";
import { grantKey } from "../../../src/sep41/checks/approve.ts";
import { burnFromCheck } from "../../../src/sep41/checks/burn_from.ts";
import {
	APPLIED,
	OWNER,
	okResponse,
	rejected,
	SPENDER,
	sequencedServer,
	settledFailure,
	stubSubmit,
	writeCtx,
} from "../fixtures.ts";

/**
 * Offline coverage for the burn_from check.
 *
 * Two quantities move and a third must not: the holder is debited, the
 * allowance drawn down, and the spender untouched — debiting it alongside
 * would be double-spending. What matters here is that no configuration
 * problem, and no missing permission, ever reaches a FAIL.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

describe("burnFromCheck", () => {
	// Reads in order: holder, spender, seed-allowance, holder re-read after
	// the setup submit, post-approval allowance, then after the burn:
	// holder, spender, allowance.
	it("PASSes when the holder is debited and the allowance consumed", async () => {
		stubSubmit(APPLIED);
		const result = await burnFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(7n),
					okResponse(0n),
					okResponse(100n),
					okResponse(1n),
					okResponse(99n),
					okResponse(7n),
					okResponse(0n),
				]),
			),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("holder -1");
		expect(result.actual).toContain("allowance -1");
	});

	// The delta asserts against the post-setup baseline: the approval was
	// signed by the holder, so a premise read from before it is stale on a
	// fee-asset by exactly the network's charge.
	it("asserts against the post-setup baseline, not the premise reads", async () => {
		stubSubmit(APPLIED);
		const result = await burnFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(7n),
					okResponse(0n),
					okResponse(99999n),
					okResponse(1n),
					okResponse(99998n),
					okResponse(7n),
					okResponse(0n),
				]),
			),
		);
		expect(result.status).toBe("PASS");
		expect(result.evidence.before).toEqual({
			holder: "99999",
			spender: "7",
			allowance: "1",
		});
	});

	it("FAILs when the allowance survived the burn", async () => {
		stubSubmit(APPLIED);
		const result = await burnFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(7n),
					okResponse(0n),
					okResponse(100n),
					okResponse(1n),
					okResponse(99n),
					okResponse(7n),
					okResponse(1n),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("allowance 0, expected -1");
	});

	// The header promises the spender pays nothing. A contract that debited
	// it alongside the holder would be double-spending.
	it("FAILs when the spender was debited too", async () => {
		stubSubmit(APPLIED);
		const result = await burnFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(7n),
					okResponse(0n),
					okResponse(100n),
					okResponse(1n),
					okResponse(99n),
					okResponse(6n),
					okResponse(0n),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("spender -1");
	});

	it("is UNVERIFIABLE without both keys", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await burnFromCheck.run(
			writeCtx(sequencedServer([okResponse(100n)]), { spenderSigns: false }),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("SPENDER_SECRET");
		expect(submit).not.toHaveBeenCalled();
	});

	// Same reasoning as transfer_from: a grant this run did not create may
	// have expired, and allowance() cannot show that.
	it("is UNVERIFIABLE when a standing allowance is refused", async () => {
		const submit = stubSubmit(rejected("HostError: Error(Contract, #4)"));
		const result = await burnFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(7n),
					// Already sufficient, so setup is skipped.
					okResponse(50n),
					okResponse(50n),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("did not create");
		expect(submit).toHaveBeenCalledTimes(1);
	});

	// Same registry path for burns: a fresh grant cannot have expired, so
	// refusing it is the contract's answer.
	it("FAILs when a previously established allowance is refused", async () => {
		stubSubmit(rejected("HostError: Error(Contract, #4)"));
		const ctx = writeCtx(
			sequencedServer([
				okResponse(100n),
				okResponse(7n),
				// Sufficient, so setup is skipped — but approve ran first.
				okResponse(50n),
				okResponse(50n),
			]),
		);
		ctx.establishedAllowances.add(grantKey(OWNER, SPENDER));
		const result = await burnFromCheck.run(ctx);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("the contract itself granted");
	});

	// The native XLM SAC gates burn_from the same way it gates burn. The
	// clause is still unmet — SEP-41 exempts nothing — so the verdict holds
	// and only the sentence changes, telling a reader this is a documented
	// property of XLM rather than a defect to chase. See burn.test.ts for
	// the fuller reasoning.
	it("names the native-asset gate while still FAILing the clause", async () => {
		stubSubmit(rejected("operation invalid on native asset"));
		const ctx = writeCtx(
			sequencedServer([
				okResponse(100n),
				okResponse(7n),
				okResponse(50n),
				okResponse(50n),
			]),
		);
		ctx.establishedAllowances.add(grantKey(OWNER, SPENDER));
		const result = await burnFromCheck.run(ctx);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("native asset");
		expect(result.actual).toContain("known property of XLM");
		expect(result.actual).not.toContain("the contract itself granted");
	});

	// Registry populated, so the standing downgrade does not apply — but a
	// ledger failure is not the contract's answer, and the FAIL above is
	// what this input would otherwise reach.
	it("is UNVERIFIABLE when an established allowance's burn failed on-chain", async () => {
		stubSubmit(settledFailure("transaction abc123 failed on-chain"));
		const ctx = writeCtx(
			sequencedServer([
				okResponse(100n),
				okResponse(7n),
				okResponse(50n),
				okResponse(50n),
			]),
		);
		ctx.establishedAllowances.add(grantKey(OWNER, SPENDER));
		const result = await burnFromCheck.run(ctx);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("reached the ledger and failed there");
	});
});
