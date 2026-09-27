import { scValToNative } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	selfTransferCheck,
	zeroAmountTransferCheck,
} from "../../../src/sep41/checks/no-op-transfer.ts";
import {
	APPLIED,
	errorResponse,
	OWNER,
	okResponse,
	rejected,
	sequencedServer,
	settledFailure,
	stubSubmit,
	writeCtx,
} from "../fixtures.ts";

/**
 * Offline coverage for the two calls that must not move value.
 *
 * These are the only checks in the suite where **both** answers are
 * conformant. SEP-41 imposes no rule on a zero amount or a self-transfer,
 * so a contract may accept either as a no-op or refuse it, and asserting
 * "must reject" would invent a requirement and FAIL a correct token. What
 * is asserted instead is arithmetic: whichever way the contract answers,
 * the balance has to be where it started.
 *
 * So the danger these guard against is the reverse of the usual one — not a
 * missed refusal, but a *silent* acceptance that moved something.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

describe("zeroAmountTransferCheck", () => {
	// Accepting is conformant, provided nothing moved.
	it("PASSes when a zero transfer is accepted and the balance holds", async () => {
		stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(7n),
					okResponse(100n),
					okResponse(7n),
				]),
			),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("accepted");
		// Both sides named, because both were observed — the PASS claims no
		// more than the reads support.
		expect(result.actual).toContain("both balances held, at 100 and 7");
		expect(result.evidence.before).toEqual({ holder: "100", recipient: "7" });
		expect(result.evidence.after).toEqual({ holder: "100", recipient: "7" });
	});

	// The bug the recipient read exists for: the sender holds steady while
	// the far side is credited out of nothing. Watching only the sender
	// would have called this conformant.
	it("FAILs when the recipient gained on a zero transfer", async () => {
		stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(7n),
					okResponse(100n),
					okResponse(8n),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("the holder held at 100");
		expect(result.actual).toContain("recipient moved from 7 to 8");
		expect(result.actual).toContain("without leaving anywhere");
	});

	// Half an observation cannot say whether value appeared, so an
	// unreadable recipient is not a verdict either way.
	it("is UNVERIFIABLE when the recipient cannot be read afterwards", async () => {
		stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(7n),
					okResponse(100n),
					errorResponse("trustline entry is missing for account G..."),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("unknown whether value appeared");
		expect(result.evidence.txHash).toBe("abc123");
		// `before` and `after` name the same accounts. Dropping the
		// recipient from `after` because it could not be read makes a
		// reader diffing the two see an account that vanished rather than
		// one this run could not see.
		expect(Object.keys(result.evidence.before ?? {}).sort()).toEqual(
			Object.keys(result.evidence.after ?? {}).sort(),
		);
		expect(
			(result.evidence.after as Record<string, string>).recipient,
		).toContain("unreadable");
	});

	// The finding a zero transfer is most likely to expose on the far side:
	// the recipient credited into negative territory. That is a defective
	// read, which is the contract's doing — so it FAILs. Reporting
	// UNVERIFIABLE would be worse than losing a verdict: `readQuantity` has
	// already recorded the negative, so the run's soundness flag is set,
	// every later check defers to a finding nobody stated, and the process
	// exits 2 for a contract that minted.
	it("FAILs when the recipient's balance went negative", async () => {
		stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n), // holder before
					okResponse(0n), // recipient before
					okResponse(100n), // holder after: held
					okResponse(-1n), // recipient after: impossible
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("negative");
		expect(result.evidence.txHash).toBe("abc123");
	});

	// A finding already earned on the holder's side must not be discarded
	// because the far side could not be read. The holder moved; that is the
	// FAIL, whatever the recipient says.
	it("FAILs on a moved holder even when the recipient is unreadable", async () => {
		stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n), // holder before
					okResponse(7n), // recipient before
					okResponse(101n), // holder after: moved on a zero transfer
					errorResponse("trustline entry is missing for account G..."),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("moved from 100 to 101");
		expect(result.evidence.txHash).toBe("abc123");
	});

	// A generated recipient is only observable while this process lives. A
	// contract wrong enough to move value on a zero transfer would send it
	// somewhere unrecoverable.
	it("is UNVERIFIABLE when the recipient is a generated throwaway", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await zeroAmountTransferCheck.run({
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

	it("is UNVERIFIABLE when the recipient is the asset issuer", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(2n ** 63n - 1n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("recipient is the asset issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	// Refusing is equally conformant. The message has to say so, or a reader
	// will take the PASS as evidence of a rule the spec never stated.
	it("PASSes when a zero transfer is refused, and says refusing is allowed", async () => {
		stubSubmit(rejected("HostError: Error(Contract, #4)"));
		const result = await zeroAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(7n)])),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("refused");
		expect(result.actual).toContain("permits refusing");
		// Both premises, same as the accepted path: the recipient was read to
		// prove it is not the issuer, so this PASS shows what it was checked
		// against rather than half of it.
		expect(result.evidence.before).toEqual({ holder: "100", recipient: "7" });
	});

	// The finding: a contract that mints or burns on a zero transfer.
	it("FAILs when a zero transfer moved the balance", async () => {
		stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(7n),
					okResponse(101n),
					okResponse(7n),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("moved from 100 to 101");
		expect(result.actual).toContain("must move nothing");
		expect(result.evidence.txHash).toBe("abc123");
	});

	// An accepted call whose result cannot be read proves nothing either
	// way — it is not evidence the balance held.
	it("is UNVERIFIABLE when the balance cannot be read after acceptance", async () => {
		stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(100n),
					okResponse(7n),
					errorResponse("trustline entry is missing for account G..."),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("unknown whether anything moved");
		// The detail names why: a bare "unreadable" leaves the reader
		// guessing between a trap, an archive and a transport failure.
		expect(result.actual).toContain("but a balance could not be read, so");
		// The call did land, so its hash is the handle a reader chases — and
		// it belongs in txHash, not in the error slot where a diagnostic goes.
		expect(result.evidence.txHash).toBe("abc123");
		expect(result.evidence.error).toBeUndefined();
	});

	it("is UNVERIFIABLE when the write died on the ledger", async () => {
		stubSubmit(settledFailure("transaction abc123 failed on-chain"));
		const result = await zeroAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(7n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("failed on-chain");
	});

	// The call landed, so its hash is evidence whatever the read does next.
	// Unlike the FAIL paths elsewhere, the verdict stays UNVERIFIABLE: an
	// unread balance leaves it genuinely unknown whether anything moved.
	it("keeps the hash as UNVERIFIABLE when the after-read throws", async () => {
		stubSubmit(APPLIED);
		let reads = 0;
		const server = sequencedServer([okResponse(100n), okResponse(7n)]);
		const inner = server.simulateTransaction.bind(server);
		vi.spyOn(server, "simulateTransaction").mockImplementation(async (tx) => {
			reads += 1;
			if (reads === 3) {
				throw new Error("Request failed: ECONNREFUSED");
			}
			return inner(tx);
		});
		const result = await zeroAmountTransferCheck.run(writeCtx(server));
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.evidence.txHash).toBe("abc123");
		expect(result.evidence.error).toContain("ECONNREFUSED");
	});

	// The recipient after-read is the fourth call, and it had no guard: a
	// transport failure there reached the runner as SKIPPED and took the
	// hash of an accepted call down with it.
	it("keeps the hash as UNVERIFIABLE when the recipient after-read throws", async () => {
		stubSubmit(APPLIED);
		let reads = 0;
		const server = sequencedServer([
			okResponse(100n),
			okResponse(7n),
			okResponse(100n),
		]);
		const inner = server.simulateTransaction.bind(server);
		vi.spyOn(server, "simulateTransaction").mockImplementation(async (tx) => {
			reads += 1;
			if (reads === 4) {
				throw new Error("Request failed: ECONNREFUSED");
			}
			return inner(tx);
		});
		const result = await zeroAmountTransferCheck.run(writeCtx(server));
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("unknown whether value appeared");
		expect(result.evidence.txHash).toBe("abc123");
		expect(result.evidence.error).toContain("ECONNREFUSED");
		// Same parity rule as the unreadable case above: a transport throw
		// is still a recipient this run could not see, not one that left.
		expect(
			(result.evidence.after as Record<string, string>).recipient,
		).toContain("unreadable");
	});

	// Zero moves nothing even against an empty holder, so unlike the other
	// negative checks this one needs no minimum balance.
	it("still assesses a holder with nothing", async () => {
		stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(
				sequencedServer([
					okResponse(0n),
					okResponse(0n),
					okResponse(0n),
					okResponse(0n),
				]),
			),
		);
		expect(result.status).toBe("PASS");
	});

	it("is UNVERIFIABLE when holder and recipient are the same address", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const result = await zeroAmountTransferCheck.run({
			...ctx,
			parties: {
				owner: ctx.parties.owner,
				spender: { ...ctx.parties.spender, address: ctx.parties.owner.address },
			},
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("self-transfer case");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE without the holder's key", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n)]), { ownerSigns: false }),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("OWNER_SECRET");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when the holder is the asset issuer", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(sequencedServer([okResponse(2n ** 63n - 1n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	it("FAILs a defective balance rather than calling it unreadable", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await zeroAmountTransferCheck.run(
			writeCtx(sequencedServer([errorResponse("Error(Contract, #7)")])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("the premise cannot be established");
		expect(submit).not.toHaveBeenCalled();
	});
});

describe("selfTransferCheck", () => {
	it("PASSes when a self-transfer is accepted and nets zero", async () => {
		stubSubmit(APPLIED);
		const result = await selfTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(100n)])),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("held at 100");
	});

	it("PASSes when a self-transfer is refused", async () => {
		stubSubmit(rejected("HostError: Error(Contract, #4)"));
		const result = await selfTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n)])),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("permits refusing");
	});

	// The finding this exists for: debited without being credited, so the
	// holder lost a unit sending to itself.
	it("FAILs when the holder was debited without being credited", async () => {
		stubSubmit(APPLIED);
		const result = await selfTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(99n)])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("moved from 100 to 99");
		expect(result.actual).toContain("net zero");
	});

	// The other direction, and the one seen in the wild: a contract that
	// reads both balances into locals before writing either lets the credit
	// overwrite the debit, so the holder *gains*. fixtures/vulnerable-token
	// does exactly this, and the live log caught it as 1000 → 1001. Pinned
	// separately from the loss above because a check that only noticed
	// subtraction would pass the token that mints.
	it("FAILs when the credit overwrote the debit and the holder gained", async () => {
		stubSubmit(APPLIED);
		const result = await selfTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n), okResponse(101n)])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("moved from 100 to 101");
		expect(result.actual).toContain("net zero");
	});

	// Unlike the zero case, this one moves a real unit — so a refusal
	// against an empty holder would say "empty", not "self-transfer".
	it("is UNVERIFIABLE when the holder has nothing to send itself", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await selfTransferCheck.run(
			writeCtx(sequencedServer([okResponse(0n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("account is empty");
		expect(submit).not.toHaveBeenCalled();
	});

	// The recipient is the holder by construction, so a distinct spender is
	// irrelevant — the check works whatever SPENDER_ADDRESS says.
	it("runs regardless of the spender, since the holder is both sides", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([okResponse(100n), okResponse(100n)]));
		const result = await selfTransferCheck.run({
			...ctx,
			parties: {
				owner: ctx.parties.owner,
				spender: { ...ctx.parties.spender, isThrowaway: true },
			},
		});
		expect(result.status).toBe("PASS");
		// The point of the variant: both sides name the holder, whatever
		// SPENDER_ADDRESS says. Decoded rather than counted — a check that
		// sent to the spender would still have three arguments and would be
		// testing an ordinary transfer.
		const call = submit.mock.calls[0]?.[1];
		expect(call?.args.map((arg) => scValToNative(arg))).toEqual([
			OWNER,
			OWNER,
			1n,
		]);
	});

	it("is UNVERIFIABLE without the holder's key", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await selfTransferCheck.run(
			writeCtx(sequencedServer([okResponse(100n)]), { ownerSigns: false }),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("OWNER_SECRET");
		expect(submit).not.toHaveBeenCalled();
	});
});
