import { scValToNative } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overBalanceTransferCheck } from "../../../src/sep41/checks/over-balance.ts";
import {
	APPLIED,
	errorResponse,
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
 * Offline coverage for the over-balance refusal.
 *
 * A negative check, so the verdict mapping is inverted: refusing is the
 * PASS and succeeding is the finding. What these lock down is that only the
 * *contract's own* refusal earns the PASS — a fee failure, an asset-policy
 * refusal or a timeout each look identical from here and must report
 * UNVERIFIABLE, because crediting them would certify arithmetic the
 * contract was never asked to perform.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

describe("overBalanceTransferCheck", () => {
	// The whole point: refusing is correct, so it is the PASS.
	it("PASSes when the contract refuses more than the holder owns", async () => {
		const submit = stubSubmit(rejected("HostError: Error(Contract, #2)"));
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("a transfer of 101");
		expect(result.actual).toContain("was refused");
		expect(result.evidence.before).toEqual({ holder: "100", recipient: "5" });
		// The refusal's own words are what justify a PASS on a check whose
		// verdict *is* the refusal — without them a reader has a claim and
		// no basis for it, and a regression dropping them would pass a test
		// that only pinned `before`.
		expect(result.evidence.error).toContain("Error(Contract, #2)");
		// One unit past what exists, not a huge number: a contract may reject
		// u128::MAX for encoding reasons that say nothing about its floor.
		const call = submit.mock.calls[0]?.[1];
		expect(call?.method).toBe("transfer");
		expect(call?.args).toHaveLength(3);
		// Decoded back from the ScVals, because that is what the contract
		// actually sees: one past the observed balance, signed by the holder.
		expect(call?.args.map((arg) => scValToNative(arg))).toEqual([
			OWNER,
			SPENDER,
			101n,
		]);
	});

	// A contract that lets a holder move more than it owns is either minting
	// silently or wrapping the subtraction. Both spend value never issued.
	it("is UNVERIFIABLE when the balance is at the top of the i128 range", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([okResponse(2n ** 127n - 1n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("cannot be encoded");
		expect(submit).not.toHaveBeenCalled();
	});
	it("FAILs when the over-balance transfer succeeds, and reads back the damage", async () => {
		stubSubmit(APPLIED);
		const result = await overBalanceTransferCheck.run(
			// before 100, then the after-read once the move went through.
			writeCtx(
				sequencedServer([okResponse(100n), okResponse(5n), okResponse(0n)]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("succeeded against a balance of 100");
		expect(result.actual).toContain("never issued");
		expect(result.evidence.txHash).toBe("abc123");
		expect(result.evidence.after).toEqual({ holder: "0" });
	});

	// The FAIL still stands if the after-read fails: the move is already
	// evidenced by its hash, and the balance is only the diagnosis.
	it("FAILs even when the balance cannot be read afterwards", async () => {
		stubSubmit(APPLIED);
		const result = await overBalanceTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					// Third read, after the move landed. A trustline error rather
					// than a trap: a trap here would be a defect the check must
					// not silently fold into the after-state, and using one would
					// let this test pass for the wrong reason.
					errorResponse("trustline entry is missing for account G..."),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("never issued");
		expect(result.evidence.after).toEqual({
			holder: "unreadable after the move",
		});
	});

	// A ledger failure is not the contract refusing — fee, sequence race,
	// expired footprint. Crediting it would certify a floor check that was
	// never reached.
	it("is UNVERIFIABLE when the write died on the ledger", async () => {
		stubSubmit(settledFailure("transaction abc123 failed on-chain"));
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("failed on-chain");
	});

	// The asset's own policy refusing says nothing about the contract's
	// arithmetic. Found on testnet with an AUTH_REQUIRED asset.
	it("is UNVERIFIABLE when the refusal is the asset's trustline policy", async () => {
		stubSubmit(rejected("trustline entry is missing for account G..."));
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("trustline policy");
	});

	it("is UNVERIFIABLE on a timeout, carrying the hash to look up", async () => {
		stubSubmit({ kind: "timeout", txHash: "def456" });
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.evidence.txHash).toBe("def456");
		expect(result.actual).toContain("may still apply");
	});

	// A WASM contract's spec is authoritative, so a missing member is
	// answered without spending a simulation — and it is an interface
	// verdict whatever layer the check itself belongs to.
	it("reports NOT_IMPLEMENTED when the spec declares no transfer", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([]));
		const result = await overBalanceTransferCheck.run({
			...ctx,
			specFunctions: ["balance", "decimals"],
		});
		expect(result.status).toBe("NOT_IMPLEMENTED");
		expect(result.layer).toBe("interface");
		expect(submit).not.toHaveBeenCalled();
	});

	// Archived state is not a refusal: the call never executed.
	it("is UNVERIFIABLE when the ledger entry must be restored first", async () => {
		stubSubmit({ kind: "restore", diagnostics: "entry archived" });
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("archived state");
	});

	// A timeout with no hash observed still reports honestly — it says so
	// rather than printing an empty identifier.
	it("is UNVERIFIABLE on a timeout that never saw a hash", async () => {
		stubSubmit({ kind: "timeout", txHash: "" });
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("no transaction hash was observed");
		expect(result.evidence.txHash).toBeUndefined();
	});

	// Premise guards. None is a verdict about the contract.

	it("is UNVERIFIABLE without the holder's key", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n)]), { ownerSigns: false }),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("OWNER_SECRET");
		expect(submit).not.toHaveBeenCalled();
	});

	// The guard is for the contract that does *not* refuse: the FAIL would
	// be right, and the whole balance plus one would have gone to a key this
	// process throws away.
	it("is UNVERIFIABLE when the recipient is a generated throwaway", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await overBalanceTransferCheck.run({
			...ctx,
			parties: {
				owner: ctx.parties.owner,
				spender: { ...ctx.parties.spender, isThrowaway: true },
			},
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("discarded at exit");
		expect(submit).not.toHaveBeenCalled();
	});

	// A self-transfer nets zero at any size, so a contract could allow it
	// without ever doing the arithmetic under test.
	it("is UNVERIFIABLE when holder and recipient are the same address", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await overBalanceTransferCheck.run({
			...ctx,
			parties: {
				owner: ctx.parties.owner,
				spender: { ...ctx.parties.spender, address: ctx.parties.owner.address },
			},
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("nets zero");
		expect(submit).not.toHaveBeenCalled();
	});

	// An issuer mints on payout, so no amount exceeds what it can send —
	// the premise is unreachable, not merely hard to establish.
	it("is UNVERIFIABLE when the holder is the asset issuer", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([okResponse(2n ** 63n - 1n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	// Sending to an issuer burns rather than moves, so a refusal could be the
	// burn path rather than the floor check. Reads: holder, then recipient.
	it("is UNVERIFIABLE when the recipient is the asset issuer", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(2n ** 63n - 1n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("recipient is the asset issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	// Proceeding needs proof the recipient is not an issuer, not merely the
	// absence of proof that it is — the standard the holder read is held to.
	it("does not submit when the recipient's balance cannot be read", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await overBalanceTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					errorResponse("trustline entry is missing for account G..."),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("recipient balance unreadable");
		expect(submit).not.toHaveBeenCalled();
	});

	// A defective recipient read is the contract's fault the same way the
	// holder's is; balanceCheck FAILs the identical response.
	it("FAILs a defective recipient read rather than submitting anyway", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await overBalanceTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					errorResponse("Error(Contract, #7)"),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("the premise cannot be established");
		expect(submit).not.toHaveBeenCalled();
	});

	// A defective balance() is the contract's fault whichever check reads
	// it, and balanceCheck FAILs the same response.
	it("FAILs a defective balance rather than calling it unreadable", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await overBalanceTransferCheck.run(
			writeCtx(sequencedServer([errorResponse("Error(Contract, #7)")])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("the premise cannot be established");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when the balance is merely unreadable", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await overBalanceTransferCheck.run(
			writeCtx(
				sequencedServer([
					errorResponse("trustline entry is missing for account G..."),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(submit).not.toHaveBeenCalled();
	});
});
