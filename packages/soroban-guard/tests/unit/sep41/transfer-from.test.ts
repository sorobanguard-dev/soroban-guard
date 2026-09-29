import { afterEach, describe, expect, it, vi } from "vitest";
import * as invoke from "../../../src/core/invoke.ts";
import { grantKey } from "../../../src/sep41/checks/approve.ts";
import { transferFromCheck } from "../../../src/sep41/checks/transfer_from.ts";
import {
	APPLIED,
	errorResponse,
	OWNER,
	okResponse,
	rejected,
	SPENDER,
	sequencedServer,
	settledFailure,
	signerFor,
	stubSubmit,
	writeCtx,
} from "../fixtures.ts";

/**
 * Offline coverage for the transfer_from check.
 *
 * The distinguishing requirement is the allowance draw-down: moving the
 * tokens without consuming it leaves a standing permit to move more. What
 * matters here is that no configuration problem, and no missing permission,
 * ever reaches a FAIL.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

describe("transferFromCheck", () => {
	// Reads: owner, spender, seed-allowance, holder re-read after the setup
	// submit, post-approval allowance, then after the write: owner,
	// spender, allowance.
	it("PASSes when both balances and the allowance all move", async () => {
		stubSubmit(APPLIED);
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					okResponse(0n),
					okResponse(100n),
					okResponse(1n),
					okResponse(99n),
					okResponse(6n),
					okResponse(0n),
				]),
			),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("allowance -1");
	});

	// The baseline the delta asserts against is read after the setup, not
	// before it: the approval is signed by the holder, so on a fee-asset
	// the premise reads predate a fee debit this check itself caused.
	it("asserts against the post-setup baseline, not the premise reads", async () => {
		stubSubmit(APPLIED);
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					okResponse(0n),
					okResponse(99999n),
					okResponse(1n),
					okResponse(99998n),
					okResponse(6n),
					okResponse(0n),
				]),
			),
		);
		expect(result.status).toBe("PASS");
		expect(result.evidence.before).toEqual({
			holder: "99999",
			recipient: "5",
			allowance: "1",
		});
	});

	// A defective re-read is a premise failure with the setup already
	// landed: the contract is at fault, so it FAILs rather than reporting
	// unknown.
	it("FAILs when the post-setup baseline cannot be trusted", async () => {
		stubSubmit(APPLIED);
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					okResponse(0n),
					errorResponse("Error(Contract, #7)"),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("before state cannot be trusted");
	});

	// The distinguishing requirement: moving tokens without consuming the
	// allowance leaves a standing permit to move more.
	it("FAILs when the allowance was not consumed", async () => {
		stubSubmit(APPLIED);
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					okResponse(0n),
					okResponse(100n),
					okResponse(1n),
					okResponse(99n),
					okResponse(6n),
					okResponse(1n),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("allowance 0, expected -1");
	});

	// On a token that is not the fee asset the recipient's shortfall cannot
	// be the network's charge: the fee is paid in XLM, so a credit that
	// never arrived is the contract short-changing the recipient.
	it("FAILs a recipient shortfall on a token that is not the fee asset", async () => {
		stubSubmit(APPLIED);
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					okResponse(0n),
					okResponse(100n),
					okResponse(1n),
					okResponse(99n),
					okResponse(5n),
					okResponse(0n),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("recipient 0, expected +1");
	});

	it("is UNVERIFIABLE without the spender's key", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await transferFromCheck.run(
			writeCtx(sequencedServer([okResponse(100n)]), { spenderSigns: false }),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("SPENDER_SECRET");
		expect(submit).not.toHaveBeenCalled();
	});

	// A setup failure says nothing about transfer_from itself.
	it("is UNVERIFIABLE when the setup approval is refused", async () => {
		stubSubmit(rejected("approve failed"));
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([okResponse(100n), okResponse(5n), okResponse(0n)]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("could not establish an allowance");
	});

	// A standing allowance is spent rather than overwritten, so the suite
	// never watched it land and cannot see its expiry — allowance() returns
	// the amount alone. A refusal there may be an expired grant, so it is
	// not evidence against the contract.
	it("is UNVERIFIABLE when a standing allowance is refused", async () => {
		const submit = stubSubmit(rejected("HostError: Error(Contract, #4)"));
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					// Already sufficient, so setup is skipped entirely.
					okResponse(50n),
					okResponse(50n),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("did not create");
		// Skipped setup means one submission, not two.
		expect(submit).toHaveBeenCalledTimes(1);
	});

	// The mirror: an allowance this run established is one the contract is
	// answerable for, so refusing it is a real finding.
	it("FAILs when an allowance the suite established is refused", async () => {
		// The setup approval must land; only the transfer_from is refused.
		// One stub for both would exit at the setup guard instead.
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(rejected("HostError: Error(Contract, #4)"));
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					// Insufficient, so the suite seeds the allowance itself.
					okResponse(0n),
					okResponse(100n),
					okResponse(1n),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("the contract itself granted");
	});

	// The registry path: an earlier check's approval is fresh by
	// construction (it cannot have expired mid-run), so a refusal against
	// it is answerable even though this check skipped its own setup.
	it("FAILs when a previously established allowance is refused", async () => {
		stubSubmit(rejected("HostError: Error(Contract, #4)"));
		const ctx = writeCtx(
			sequencedServer([
				okResponse(100n),
				okResponse(5n),
				// Sufficient, so setup is skipped — but approve ran first.
				okResponse(50n),
				okResponse(50n),
			]),
		);
		ctx.establishedAllowances.add(grantKey(OWNER, SPENDER));
		const result = await transferFromCheck.run(ctx);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("the contract itself granted");
	});

	// The same setup as the FAIL above — registry populated, so the standing
	// downgrade does not apply — but the refusal came from the ledger, not
	// the contract. Without the settled guard this is exactly the input that
	// reaches that FAIL and accuses a conformant contract.
	it("is UNVERIFIABLE when an established allowance's spend failed on-chain", async () => {
		stubSubmit(settledFailure("transaction abc123 failed on-chain"));
		const ctx = writeCtx(
			sequencedServer([
				okResponse(100n),
				okResponse(5n),
				okResponse(50n),
				okResponse(50n),
			]),
		);
		ctx.establishedAllowances.add(grantKey(OWNER, SPENDER));
		const result = await transferFromCheck.run(ctx);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("reached the ledger and failed there");
	});

	it("FAILs a defective balance rather than calling it unreadable", async () => {
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([
					errorResponse("Error(Contract, #7)"),
					errorResponse("Error(Contract, #7)"),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("balance() trapped");
	});

	it("is UNVERIFIABLE when the recipient was generated for this run", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await transferFromCheck.run({
			...ctx,
			parties: {
				owner: ctx.parties.owner,
				spender: {
					address: SPENDER,
					isThrowaway: true,
					signer: signerFor(SPENDER),
				},
			},
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("discarded at exit");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when holder and spender are the same address", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await transferFromCheck.run({
			...ctx,
			parties: {
				owner: ctx.parties.owner,
				spender: {
					address: OWNER,
					isThrowaway: false,
					signer: signerFor(OWNER),
				},
			},
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("same address");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when the holder is the asset issuer", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await transferFromCheck.run(
			writeCtx(sequencedServer([okResponse(2n ** 63n - 1n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when the recipient is the asset issuer", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await transferFromCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(2n ** 63n - 1n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE on submission timeout, carrying the hash", async () => {
		stubSubmit({ kind: "timeout", txHash: "deadbeef" });
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					okResponse(50n),
					okResponse(50n),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("deadbeef");
	});

	it("is UNVERIFIABLE when archived state must be restored", async () => {
		stubSubmit({ kind: "restore", diagnostics: "restore me" });
		const result = await transferFromCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					okResponse(50n),
					okResponse(50n),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("archived state");
	});

	it("reports NOT_IMPLEMENTED when the spec declares no transfer_from", async () => {
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await transferFromCheck.run({
			...ctx,
			specFunctions: ["balance", "decimals"],
		});
		expect(result.status).toBe("NOT_IMPLEMENTED");
		expect(result.layer).toBe("interface");
	});
});
