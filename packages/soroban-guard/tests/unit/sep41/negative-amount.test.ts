import { scValToNative } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { negativeAmountTransferCheck } from "../../../src/sep41/checks/negative-amount.ts";
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
 * Offline coverage for the negative-amount refusal.
 *
 * `i128` is signed, so `-1` encodes cleanly and reaches the contract. The
 * danger is a contract that subtracts without checking the sign: read as a
 * reversed transfer, `transfer(attacker, victim, -1)` debits the victim
 * while the authorization check passes on the attacker. Refusing is
 * required, so a success is a FAIL — and the direction the balance moved
 * says which bug it is.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

describe("negativeAmountTransferCheck", () => {
	// Reads: holder, then recipient.
	it("PASSes when the contract refuses a negative amount", async () => {
		const submit = stubSubmit(rejected("HostError: Error(Contract, #3)"));
		const result = await negativeAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("-1");
		expect(result.actual).toContain("refused");
		// The premise both balances were read for: a refusal against an
		// unchecked counterparty could be standing, not a sign check.
		expect(result.evidence.before).toEqual({
			holder: "100",
			recipient: "5",
		});
		// The amount must reach the contract as a signed i128, not be clamped
		// or dropped on the way — a check that silently sent 1 would earn a
		// PASS for a refusal that says nothing about the sign. Decoded back
		// from the ScVals, because that is what the contract actually sees.
		const call = submit.mock.calls[0]?.[1];
		expect(call?.method).toBe("transfer");
		expect(call?.args.map((arg) => scValToNative(arg))).toEqual([
			OWNER,
			SPENDER,
			-1n,
		]);
	});

	// The dangerous bug: the sign was honoured and the transfer ran
	// backwards, so the holder gained what the counterparty lost.
	it("FAILs and names a reversed transfer when the holder gained", async () => {
		stubSubmit(APPLIED);
		const result = await negativeAmountTransferCheck.run(
			writeCtx(
				sequencedServer([okResponse(100n), okResponse(5n), okResponse(101n)]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("opposite direction");
		expect(result.actual).toContain("anyone can withdraw from anyone");
		expect(result.evidence.txHash).toBe("abc123");
	});

	// The other bug: the sign was discarded, so it behaved as a positive
	// transfer. Still a FAIL — the call should not have been accepted.
	it("FAILs and names a discarded sign when the holder did not gain", async () => {
		stubSubmit(APPLIED);
		const result = await negativeAmountTransferCheck.run(
			writeCtx(
				sequencedServer([okResponse(100n), okResponse(5n), okResponse(99n)]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("sign being discarded");
	});

	// Accepted without effect is its own outcome, not a discarded sign: a
	// contract can take the call and move nothing, which is still wrong
	// (the call should have been refused) but a different bug than either
	// direction above.
	it("FAILs distinctly when the balance did not change at all", async () => {
		stubSubmit(APPLIED);
		const result = await negativeAmountTransferCheck.run(
			writeCtx(
				sequencedServer([okResponse(100n), okResponse(5n), okResponse(100n)]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("did not change");
		expect(result.actual).not.toContain("sign being discarded");
	});

	// The case the holder's balance alone cannot describe: a reversed
	// transfer debits the recipient, and if the holder happens to land back
	// where it started, watching only the holder would report "accepted
	// without being refused" while a third party was robbed. The recipient
	// read is what tells those apart.
	it("names the recipient's loss when the holder's balance is unchanged", async () => {
		stubSubmit(APPLIED);
		const result = await negativeAmountTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n), // holder before
					okResponse(5n), // recipient before
					okResponse(100n), // holder after: unchanged
					okResponse(4n), // recipient after: one unit poorer
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("the recipient's fell");
		expect(result.actual).toContain("never authorized it");
		// The bare "did not change" reading would have been the wrong
		// diagnosis, not merely a less detailed one.
		expect(result.actual).not.toContain("accepted without being refused");
		expect(result.evidence.after).toEqual({ holder: "100", recipient: "4" });
	});

	// A defective after-read is still the contract's fault — but "could not
	// be read" would hide which fault. The defect detail names it.
	it("FAILs with the defect detail when the after-read is defective", async () => {
		stubSubmit(APPLIED);
		const result = await negativeAmountTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					errorResponse("Error(Contract, #7)"),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("could not be trusted");
		expect(result.actual).toContain("balance() trapped");
		expect(result.evidence.error).toContain("Error(Contract, #7)");
		expect(result.evidence.after).toEqual({
			holder: "unreadable (defective read)",
			// The recipient read follows the holder's and is guarded, so an
			// exhausted transport leaves it unread rather than discarding a
			// FAIL that the holder's side already earned.
			recipient: "unreadable",
		});
	});

	// The move already landed, so the FAIL is earned. Letting a transport
	// throw escape would reach the runner as SKIPPED and discard the hash
	// along with the finding.
	it("keeps the FAIL and its hash when the after-read throws", async () => {
		stubSubmit(APPLIED);
		let reads = 0;
		const server = sequencedServer([okResponse(100n), okResponse(5n)]);
		const inner = server.simulateTransaction.bind(server);
		vi.spyOn(server, "simulateTransaction").mockImplementation(async (tx) => {
			reads += 1;
			if (reads === 3) {
				throw new Error("Request failed: ECONNREFUSED");
			}
			return inner(tx);
		});
		const result = await negativeAmountTransferCheck.run(writeCtx(server));
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("could not be read");
		expect(result.evidence.txHash).toBe("abc123");
		expect(result.evidence.error).toContain("ECONNREFUSED");
	});

	// Only the contract's own refusal earns the PASS.

	it("is UNVERIFIABLE when the write died on the ledger", async () => {
		stubSubmit(settledFailure("transaction abc123 failed on-chain"));
		const result = await negativeAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("failed on-chain");
	});

	it("is UNVERIFIABLE when the refusal is the asset's trustline policy", async () => {
		stubSubmit(rejected("trustline entry is missing for account G..."));
		const result = await negativeAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("trustline policy");
	});

	it("is UNVERIFIABLE on a timeout, carrying the hash", async () => {
		stubSubmit({ kind: "timeout", txHash: "def456" });
		const result = await negativeAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.evidence.txHash).toBe("def456");
	});

	// Premise guards.

	it("is UNVERIFIABLE without the holder's key", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await negativeAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n)]), { ownerSigns: false }),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("OWNER_SECRET");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when holder and recipient are the same address", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await negativeAmountTransferCheck.run({
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

	// If the contract runs it backwards, units land on the counterparty —
	// and a generated one discards its key at exit.
	it("is UNVERIFIABLE when the recipient is a generated throwaway", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await negativeAmountTransferCheck.run({
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

	// A contract checking `balance >= abs(amount)` refuses -1 against 0 for
	// having nothing, not for the sign. Crediting that would claim a sign
	// check that never ran.
	it("is UNVERIFIABLE when the holder has nothing", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await negativeAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(0n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("account is empty");
		expect(submit).not.toHaveBeenCalled();
	});

	it.each([
		["holder", [2n ** 63n - 1n, 5n]],
		["recipient", [100n, 2n ** 63n - 1n]],
	])("is UNVERIFIABLE when the %s is the asset issuer", async (_l, reads) => {
		const submit = stubSubmit(APPLIED);
		const result = await negativeAmountTransferCheck.run(
			writeCtx(sequencedServer((reads as bigint[]).map(okResponse))),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	it("FAILs a defective balance rather than calling it unreadable", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await negativeAmountTransferCheck.run(
			writeCtx(sequencedServer([errorResponse("Error(Contract, #7)")])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("the premise cannot be established");
		expect(submit).not.toHaveBeenCalled();
	});

	it("does not submit when the recipient's balance cannot be read", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await negativeAmountTransferCheck.run(
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
});
