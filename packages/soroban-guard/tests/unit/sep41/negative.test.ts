import type { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unauthorizedTransferFromCheck } from "../../../src/sep41/checks/negative.ts";
import type { Sep41Context } from "../../../src/sep41/context.ts";
import {
	contractRefusal,
	okResponse,
	rejected,
	sequencedServer,
	settledFailure,
	stubSubmit,
	writeCtx,
} from "../fixtures.ts";

/**
 * The first check whose PASS depends on the contract *refusing*.
 *
 * Every other check confirms that something works. This one confirms that
 * something does not, which inverts the verdict mapping: a refusal is the
 * contract behaving correctly, and a success is the finding. Getting that
 * backwards would bless the drain bug the README advertises catching.
 */

/**
 * Only the spender signs here. The owner is the victim whose tokens a
 * conformant contract must refuse to move, so holding its key would not
 * just be unused — it would describe a different scenario than the one
 * under test.
 */
function ctxWith(
	server: rpc.Server,
	{ spenderSigns = true } = {},
): Sep41Context {
	return writeCtx(server, { ownerSigns: false, spenderSigns });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("unauthorizedTransferFromCheck", () => {
	// The whole point: refusing is correct behaviour, so it is the PASS.
	it("PASSes when the contract refuses a spend with no allowance", async () => {
		stubSubmit(rejected("HostError: Error(Contract, #4)"));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([okResponse(0n), okResponse(100n), okResponse(5n)]),
			),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("refused");
	});

	// The dangerous near-miss. A transaction that reached the ledger and
	// died there arrives as `rejected` too, but for reasons — fee, sequence,
	// expired footprint — that have nothing to do with allowances. Reading
	// it as a refusal would hand a clean bill of health to a contract that
	// was never asked the question, which is the one direction this check
	// must never fail in.
	it("is UNVERIFIABLE when the attempt failed on-chain rather than being refused", async () => {
		stubSubmit(settledFailure("transaction abc123 failed on-chain"));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([okResponse(0n), okResponse(100n), okResponse(5n)]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("failed on-chain");
		expect(result.evidence.error).toBe("transaction abc123 failed on-chain");
	});

	// A contract that moves tokens with no allowance lets anyone drain any
	// holder. This is the finding the tool exists to produce.
	it("FAILs when the contract allows a spend with no allowance", async () => {
		stubSubmit({ kind: "applied", txHash: "abc123", ledger: 4738627 });
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([okResponse(0n), okResponse(100n), okResponse(5n)]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("no allowance");
		// The hash proves it happened, and is what a reader chases.
		expect(result.evidence.txHash).toBe("abc123");
	});

	// A standing refusal is the asset's policy, not proof of authorization
	// enforcement — passing on it would claim evidence we do not have.
	it("is UNVERIFIABLE when the refusal is a trustline problem", async () => {
		stubSubmit(rejected("trustline entry is missing for account G..."));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([okResponse(0n), okResponse(100n), okResponse(5n)]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("trustline");
	});

	// Without a pre-existing allowance of zero there is nothing to violate.
	it("is UNVERIFIABLE when an allowance already exists", async () => {
		const submit = stubSubmit(rejected("refused"));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([okResponse(5n), okResponse(100n), okResponse(5n)]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("allowance");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when the holder has nothing worth taking", async () => {
		const submit = stubSubmit(rejected("refused"));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([okResponse(0n), okResponse(0n), okResponse(5n)]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(submit).not.toHaveBeenCalled();
	});

	// An issuer breaks this check both ways. Sending from one mints (no
	// allowance needed → applied → FAIL for a drain that never happened);
	// sending to one burns (refused → PASS crediting enforcement never
	// shown). Reads are: allowance, holder balance, spender balance.
	it.each([
		["holder is the issuer", 2n ** 63n - 1n, 5n],
		["spender is the issuer", 100n, 2n ** 63n - 1n],
	])("is UNVERIFIABLE when %s", async (_label, holder, recipient) => {
		const submit = stubSubmit(rejected("refused"));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(0n),
					okResponse(holder),
					okResponse(recipient),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	// Proceeding needs proof the recipient is not an issuer, not merely the
	// absence of proof that it is. An unreadable balance is neither.
	it("does not submit when the recipient's balance cannot be read", async () => {
		const submit = stubSubmit(rejected("refused"));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(0n),
					okResponse(100n),
					contractRefusal(13, "trustline entry is missing for account G..."),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("recipient balance unreadable");
		expect(submit).not.toHaveBeenCalled();
	});

	it("FAILs a defective recipient read rather than submitting anyway", async () => {
		const submit = stubSubmit(rejected("refused"));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([okResponse(0n), okResponse(100n), contractRefusal(7)]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("balance() trapped");
		expect(submit).not.toHaveBeenCalled();
	});

	// If the contract wrongly allows the spend, the unit lands on a key this
	// process discards at exit. The FAIL would be right; the loss is real.
	it("is UNVERIFIABLE when the spender is a generated throwaway", async () => {
		const submit = stubSubmit(rejected("refused"));
		const ctx = ctxWith(sequencedServer([okResponse(0n)]));
		const result = await unauthorizedTransferFromCheck.run({
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

	it("is UNVERIFIABLE without the spender's key", async () => {
		const submit = stubSubmit(rejected("refused"));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(sequencedServer([okResponse(0n)]), { spenderSigns: false }),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("SPENDER_SECRET");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE on submission timeout, carrying the hash", async () => {
		stubSubmit({ kind: "timeout", txHash: "deadbeef" });
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([okResponse(0n), okResponse(100n), okResponse(5n)]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("deadbeef");
	});

	it("is UNVERIFIABLE when archived state must be restored", async () => {
		stubSubmit({ kind: "restore", diagnostics: "restore me" });
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([okResponse(0n), okResponse(100n), okResponse(5n)]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("archived state");
	});

	it("is UNVERIFIABLE when the holder is the asset issuer", async () => {
		const submit = stubSubmit(rejected("refused"));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(0n),
					okResponse(2n ** 63n - 1n),
					okResponse(5n),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when the recipient is the asset issuer", async () => {
		const submit = stubSubmit(rejected("refused"));
		const result = await unauthorizedTransferFromCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(0n),
					okResponse(100n),
					okResponse(2n ** 63n - 1n),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	it("reports NOT_IMPLEMENTED when the spec declares no transfer_from", async () => {
		const ctx = ctxWith(sequencedServer([okResponse(0n)]));
		const result = await unauthorizedTransferFromCheck.run({
			...ctx,
			specFunctions: ["balance"],
		});
		expect(result.status).toBe("NOT_IMPLEMENTED");
		expect(result.layer).toBe("interface");
	});
});
