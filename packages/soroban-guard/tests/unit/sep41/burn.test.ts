import { afterEach, describe, expect, it, vi } from "vitest";
import { burnCheck } from "../../../src/sep41/checks/burn.ts";
import {
	APPLIED,
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
 * Offline coverage for the burn check.
 *
 * Only one quantity moves: a burn destroys supply rather than relocating
 * it, so there is no recipient to credit and the assertion is a single
 * debit. What matters here is that no configuration problem, and no
 * missing permission, ever reaches a FAIL.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

describe("burnCheck", () => {
	it("PASSes on a clean debit with nothing credited", async () => {
		stubSubmit(APPLIED);
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(99n)])),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("holder -1");
	});

	it("FAILs when the balance did not fall", async () => {
		stubSubmit(APPLIED);
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(100n)])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("holder 0");
	});

	// A transaction that reached the ledger and died there never reached the
	// contract's logic, so it cannot be read as "the burn was refused".
	it("is UNVERIFIABLE when the write failed on-chain rather than being refused", async () => {
		stubSubmit(settledFailure("transaction abc123 failed on-chain"));
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(100n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("reached the ledger and failed there");
		expect(result.evidence.error).toBe("transaction abc123 failed on-chain");
	});

	it("is UNVERIFIABLE with nothing to burn", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(0n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("nothing to burn");
		expect(submit).not.toHaveBeenCalled();
	});

	// Burning from an issuer does not decrease its sentinel balance, so the
	// delta would read as the burn having done nothing.
	it("is UNVERIFIABLE when the holder is the asset issuer", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(2n ** 63n - 1n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE without the holder's key", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(100n)]), { ownerSigns: false }),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("no signing authority");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when the signer signs as someone else", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await burnCheck.run({
			...ctx,
			parties: {
				owner: {
					address: OWNER,
					isThrowaway: false,
					signer: signerFor(SPENDER),
				},
				spender: ctx.parties.spender,
			},
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("signs as");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE on submission timeout, carrying the hash", async () => {
		stubSubmit({ kind: "timeout", txHash: "deadbeef" });
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(100n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("deadbeef");
	});

	it("is UNVERIFIABLE when archived state must be restored", async () => {
		stubSubmit({ kind: "restore", diagnostics: "restore me" });
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(100n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("archived state");
	});

	it("is UNVERIFIABLE when the burn is refused by trustline policy", async () => {
		stubSubmit(rejected("trustline entry is missing for account G..."));
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(100n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("trustline policy");
	});

	/**
	 * The native XLM SAC gates burn on `check_non_native` and returns
	 * `OperationNotSupportedError`. SEP-41 declares burn with no exemption
	 * in its text, so the clause is genuinely unmet and the verdict stays
	 * FAIL — downgrading it would hide a real deviation, one the spec
	 * arguably owns since it also claims the SAC implements the interface.
	 *
	 * What changes is the sentence. This is the first contract most people
	 * will point the tool at, and "your contract is broken" is the wrong
	 * thing to tell them about a documented property of XLM.
	 */
	it("names the native-asset gate while still FAILing the clause", async () => {
		stubSubmit(rejected("operation invalid on native asset"));
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(100n)])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("native asset");
		expect(result.actual).toContain("known property of XLM");
		// The generic wording would send a reader hunting a defect.
		expect(result.actual).not.toContain("affordable amount");
		expect(result.evidence.error).toContain(
			"operation invalid on native asset",
		);
	});

	// Any other refusal keeps the generic sentence: the named case must not
	// widen into an excuse for refusals it does not describe.
	it("keeps the generic sentence for a refusal it cannot name", async () => {
		stubSubmit(rejected("HostError: Error(Contract, #7)"));
		const result = await burnCheck.run(
			writeCtx(sequencedServer([okResponse(100n)])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("affordable amount");
		expect(result.actual).not.toContain("native asset");
	});

	it("reports NOT_IMPLEMENTED when the spec declares no burn", async () => {
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await burnCheck.run({
			...ctx,
			specFunctions: ["balance"],
		});
		expect(result.status).toBe("NOT_IMPLEMENTED");
		expect(result.layer).toBe("interface");
	});
});
