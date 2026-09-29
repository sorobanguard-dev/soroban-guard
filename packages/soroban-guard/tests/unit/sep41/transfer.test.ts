import {
	Account,
	Address,
	Asset,
	Keypair,
	Networks,
	type rpc,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk";
import type { Signer } from "@stellar/stellar-sdk/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as invoke from "../../../src/core/invoke.ts";
import { transferCheck } from "../../../src/sep41/checks/transfer.ts";
import type { Sep41Context } from "../../../src/sep41/context.ts";
import {
	errorResponse,
	okResponse,
	rejected,
	restoreResponse,
	sequencedServer,
	settledFailure,
	stubSubmit,
} from "../fixtures.ts";

/**
 * Offline coverage for the transfer check.
 *
 * Unlike the reads, one canned response is not enough: transfer reads a
 * balance four times (both parties, before and after) around a single
 * submission, so the stub must be a *sequence*. Each test states the
 * balances the contract reports in call order, and submitWrite is mocked
 * rather than hit — a real write costs a ledger close.
 *
 * What these lock down is the mapping, not the arithmetic: which situations
 * are the contract's fault (FAIL) and which are ours (UNVERIFIABLE). Getting
 * that backwards is the expensive bug — it accuses a conformant token.
 */

const OWNER = Keypair.random().publicKey();
const SPENDER = Keypair.random().publicKey();

/** A signer that is never actually invoked: submitWrite is mocked. */
const STUB_SIGNER = { address: OWNER } as unknown as Signer;

/**
 * `withSigner: false` means the run holds no key for the holder. Expressed
 * as a boolean rather than `signer: undefined`, because a default parameter
 * fires on undefined — `{ signer: undefined }` would silently restore the
 * stub and test the opposite of what it claims.
 */
function ctxWith(
	server: rpc.Server,
	{
		withSigner = true,
		nativeAsset = false,
	}: {
		withSigner?: boolean;
		nativeAsset?: boolean;
	} = {},
): Sep41Context {
	const signer = withSigner ? STUB_SIGNER : undefined;
	return {
		server,
		// Fee-asset runs need the native contract address: the fee excuse
		// keys off it, so a generated address would test the wrong asset.
		contractId: nativeAsset
			? Asset.native().contractId(Networks.TESTNET)
			: Address.contract(new Uint8Array(32)).toString(),
		source: new Account(OWNER, "1"),
		networkPassphrase: Networks.TESTNET,
		specFunctions: null,
		establishedAllowances: new Set(),
		soundness: {},
		parties: {
			owner: { address: OWNER, isThrowaway: false, signer },
			spender: { address: SPENDER, isThrowaway: false },
		},
	};
}

const APPLIED = {
	kind: "applied",
	txHash: "abc123",
	ledger: 4738627,
} as const;

describe("transferCheck", () => {
	// vi.spyOn patches the module for every later test in the file, so a
	// stubbed submitWrite would otherwise leak into cases that must never
	// reach it at all — such as the no-signer short-circuit.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("PASSes when the deltas match the amount moved", async () => {
		const submit = stubSubmit(APPLIED);
		// before: owner 100, spender 5 — after: owner 99, spender 6
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					okResponse(99n),
					okResponse(6n),
				]),
			),
		);
		expect(result.status).toBe("PASS");
		expect(result.evidence.txHash).toBe("abc123");
		expect(result.evidence.ledger).toBe(4738627);
		expect(result.evidence.before).toEqual({ holder: "100", recipient: "5" });
		expect(result.evidence.after).toEqual({ holder: "99", recipient: "6" });

		// The evidence alone would look identical if the call swapped the
		// parties, moved the wrong amount, or signed as someone else, so
		// assert the submission itself. Args arrive as ScVals, so they are
		// decoded back rather than compared to raw values.
		const call = submit.mock.calls[0]?.[1];
		expect(call?.method).toBe("transfer");
		expect(call?.signer.address).toBe(OWNER);
		expect(call?.args.map((arg) => scValToNative(arg))).toEqual([
			OWNER,
			SPENDER,
			1n,
		]);
	});

	it("FAILs when the recipient was not credited", async () => {
		stubSubmit(APPLIED);
		// Owner debited, spender unchanged: value vanished.
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					okResponse(99n),
					okResponse(5n),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("recipient 0");
	});

	// The native XLM SAC, in miniature. The holder signs, so it also pays
	// the network fee — in the very asset being measured — and its balance
	// drops by far more than the unit transferred. The recipient is credited
	// exactly, which is what says the contract behaved: no verdict is
	// available on the holder's side, but there is no finding either. Needs
	// the native contract address — on any other asset a shortfall cannot
	// be a fee, and the same readings FAIL below.
	it("is UNVERIFIABLE when the holder also paid the fee in this asset", async () => {
		stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(100000n), // holder before
					okResponse(5n), // recipient before
					okResponse(86185n), // holder after: -1 moved, -13814 fee
					okResponse(6n), // recipient after: credited exactly
				]),
				{ nativeAsset: true },
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("transaction fee");
		expect(result.actual).not.toContain("recipient");
	});

	// The same readings against any other token: fees there are paid in XLM,
	// so a holder short by more than the unit moved is the contract
	// double-debiting, not the network. Gated on the asset for exactly this
	// reason — an unconditional excuse would report unknown here.
	it("FAILs a holder shortfall on a token that is not the fee asset", async () => {
		stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(100n), // holder before
					okResponse(5n), // recipient before
					okResponse(98n), // holder after: debited twice
					okResponse(6n), // recipient after: credited exactly
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("holder -2, expected -1");
	});

	// And the protection that must survive it: a fee-on-transfer token also
	// debits the holder extra, but short-changes the recipient doing it.
	// That mismatch is a real finding and outranks the excused holder.
	//
	// `nativeAsset` is what makes this a precedence test rather than a
	// second mismatch test: without it the holder shortfall is an ordinary
	// mismatch, both sides land in `mismatches`, and the check would FAIL
	// even if the excuse outranked the finding.
	it("still FAILs a fee-on-transfer token that short-changes the recipient", async () => {
		stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(100000n), // holder before
					okResponse(5n), // recipient before
					okResponse(86185n), // holder after: same shape as above
					okResponse(5n), // recipient after: never credited
				]),
				{ nativeAsset: true },
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("recipient 0");
		// The excused side must not surface: a fee cannot explain away a
		// recipient that was never credited.
		expect(result.actual).not.toContain("transaction fee");
	});

	// P1: a submission that never reached the ledger is a harness failure.
	// Reporting it as FAIL would accuse a contract that was never shown the
	// transaction; it propagates instead, and the runner records SKIPPED.
	it("propagates a submission failure rather than blaming the contract", async () => {
		vi.spyOn(invoke, "submitWrite").mockRejectedValue(
			new Error("Request failed: ECONNREFUSED"),
		);
		await expect(
			transferCheck.run(
				ctxWith(sequencedServer([okResponse(100n), okResponse(5n)])),
			),
		).rejects.toThrow("ECONNREFUSED");
	});

	it("FAILs when the contract refuses an affordable, authorised transfer", async () => {
		stubSubmit(rejected("auth failed"));
		const result = await transferCheck.run(
			ctxWith(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.evidence.error).toBe("auth failed");
	});

	// Same `rejected` kind, opposite verdict. A transaction that reached the
	// ledger and died there never reached the contract's logic — fee,
	// sequence race, expired footprint — so the FAIL above would accuse it
	// of a refusal it never made.
	it("is UNVERIFIABLE when the write failed on-chain rather than being refused", async () => {
		stubSubmit(settledFailure("transaction abc123 failed on-chain"));
		const result = await transferCheck.run(
			ctxWith(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("reached the ledger and failed there");
		expect(result.evidence.error).toBe("transaction abc123 failed on-chain");
		// The transaction was included before it failed, so a reader has
		// something to look up — telling them "failed on-chain" without the
		// hash leaves them nowhere to go.
		expect(result.evidence.txHash).toBe("abc123");
		expect(result.evidence.ledger).toBe(4738627);
	});

	// A SAC enforces the asset's policy as well as the token interface.
	// Refusing these is the contract working, so FAILing accuses a
	// conformant token. Found on testnet with an AUTH_REQUIRED asset.
	// The message stays generic about which party lost standing: the
	// before-reads proved both had it, so a submit-time loss could be either.
	it.each([
		["balance is deauthorized"],
		["trustline entry is missing for account"],
	])(
		"is UNVERIFIABLE when a refusal is the asset's policy: %s",
		async (diagnostics) => {
			stubSubmit(rejected(diagnostics));
			const result = await transferCheck.run(
				ctxWith(sequencedServer([okResponse(100n), okResponse(5n)])),
			);
			expect(result.status).toBe("UNVERIFIABLE");
			expect(result.actual).toContain("trustline policy");
			// The raw diagnostic is still evidence, so a reader can check
			// the classification rather than trusting it.
			expect(result.evidence.error).toBe(diagnostics);
		},
	);

	// The three UNVERIFIABLE exits. None is a verdict about the contract, and
	// reporting any of them as FAIL would accuse a conformant token.

	it("is UNVERIFIABLE without a signer for the holder", async () => {
		const result = await transferCheck.run(
			ctxWith(sequencedServer([okResponse(100n)]), { withSigner: false }),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("OWNER_SECRET");
		expect(result.actual).toContain("holds this token");
	});

	// Sep41Context is exported, so a programmatic caller can hand us a
	// signer for someone other than the holder. A contract that enforces
	// authorization then refuses correctly, and the refusal would be
	// reported as its defect.
	it("is UNVERIFIABLE when the signer signs as someone other than the holder", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = ctxWith(sequencedServer([okResponse(100n)]));
		const result = await transferCheck.run({
			...ctx,
			parties: {
				owner: {
					address: OWNER,
					isThrowaway: false,
					signer: { address: SPENDER } as unknown as Signer,
				},
				spender: ctx.parties.spender,
			},
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain(OWNER);
		expect(result.actual).toContain(SPENDER);
		expect(submit).not.toHaveBeenCalled();
	});

	// A generated recipient's key lives only in this process. Sending to one
	// burns the unit — irreversible, and not what the operator consented to.
	// A SAC blocks it by accident (no trustline); a WASM token does not.
	it("is UNVERIFIABLE when the recipient is a generated throwaway", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = ctxWith(sequencedServer([okResponse(100n)]));
		const result = await transferCheck.run({
			...ctx,
			parties: {
				owner: ctx.parties.owner,
				spender: { address: SPENDER, isThrowaway: true },
			},
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("SPENDER_ADDRESS");
		expect(submit).not.toHaveBeenCalled();
	});

	// A restore response carries a last-known answer, which reads may use.
	// A delta may not: the transfer restores the entry, so the after-read is
	// current and the gap would be blamed on the contract.
	it("is UNVERIFIABLE when the baseline balance comes from the archive", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(sequencedServer([restoreResponse(100n), restoreResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("balances unreadable");
		expect(submit).not.toHaveBeenCalled();
	});

	// P2: a self-transfer nets zero on a conformant contract.
	it("is UNVERIFIABLE when holder and recipient are the same address", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = ctxWith(sequencedServer([okResponse(100n)]));
		const result = await transferCheck.run({
			...ctx,
			parties: {
				owner: ctx.parties.owner,
				spender: { address: OWNER, isThrowaway: false },
			},
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("same address");
		expect(submit).not.toHaveBeenCalled();
	});

	// P3: SEP-41 balances are non-negative, so this is the contract's own
	// violation — not "nothing to transfer", which would hide it.
	it("FAILs a negative balance rather than calling it nothing to transfer", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(sequencedServer([okResponse(-5n), okResponse(0n)])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("negative");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when the holder has nothing to move", async () => {
		const result = await transferCheck.run(
			ctxWith(sequencedServer([okResponse(0n), okResponse(0n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("nothing to transfer");
	});

	// Found on testnet: the issuer transfers successfully, its balance does
	// not move (i64::MAX is a sentinel, not a holding), and the delta reads
	// as value vanishing. FAILing there accuses a conformant contract.
	it("is UNVERIFIABLE when the holder is the asset issuer", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(sequencedServer([okResponse(2n ** 63n - 1n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("holder is the asset issuer");
		// Refused before submitting: no point spending a ledger close on a
		// transfer whose result cannot be judged.
		expect(submit).not.toHaveBeenCalled();
	});

	// The mirror case, and the one the first fix missed: a transfer TO the
	// issuer burns, so the recipient is never credited and the check read it
	// as value vanishing. Found by following the SAC docs, not by testing.
	it("is UNVERIFIABLE when the recipient is the asset issuer", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(sequencedServer([okResponse(100n), okResponse(2n ** 63n - 1n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("recipient is the asset issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	// P-A: the prelude reads reach the same verdict balanceCheck would.
	// A standing problem is ours, so there is no before state to compare
	// against and nothing to accuse the contract of.
	it("is UNVERIFIABLE when the before-state cannot be read for lack of standing", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					errorResponse("trustline entry is missing"),
					errorResponse("trustline entry is missing"),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("balances unreadable");
		expect(submit).not.toHaveBeenCalled();
	});

	// The same response balanceCheck FAILs must not become UNVERIFIABLE
	// here — one contract cannot get two answers in one run.
	it("FAILs when balance() traps for a reason that is not standing", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					errorResponse("Error(Contract, #7)"),
					errorResponse("Error(Contract, #7)"),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("balance() trapped");
		expect(result.evidence.error).toBe("Error(Contract, #7)");
		expect(submit).not.toHaveBeenCalled();
	});

	it("FAILs when balance() returns the wrong type", async () => {
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(xdr.ScVal.scvU32(7)),
					okResponse(xdr.ScVal.scvU32(7)),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("expected an i128");
	});

	it("is UNVERIFIABLE on submission timeout, carrying the hash", async () => {
		stubSubmit({ kind: "timeout", txHash: "deadbeef" });
		const result = await transferCheck.run(
			ctxWith(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("deadbeef");
	});

	// Both after-reads answer, but neither answers usefully — the null
	// branch. Four responses, because a short sequence would exhaust the
	// stub and exercise the throw path below instead, which returns a
	// similar-looking result and would hide that this branch is untested.
	it("omits evidence.after rather than reporting a 'null' balance", async () => {
		stubSubmit(APPLIED);
		// A standing problem, so the after-state is genuinely unknown rather
		// than defective — the one case that stays UNVERIFIABLE here.
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					errorResponse("trustline entry is missing"),
					errorResponse("trustline entry is missing"),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("unreadable afterwards");
		expect(result.evidence.after).toBeUndefined();
		expect(result.evidence.before).toEqual({ holder: "100", recipient: "5" });
		expect(result.evidence.txHash).toBe("abc123");
	});

	// CodeRabbit finding: the same defective response must not be FAIL before
	// the transfer and UNVERIFIABLE after it.
	it("FAILs an after-read defect, matching the before-read verdict", async () => {
		stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					errorResponse("Error(Contract, #7)"),
					errorResponse("Error(Contract, #7)"),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("balance() trapped");
		// The transfer did apply, so its handle is still evidence.
		expect(result.evidence.txHash).toBe("abc123");
	});

	// A negative balance is a violation wherever it shows up. balanceCheck
	// FAILs it, so both of transfer's read phases must too.
	it("FAILs a negative balance reported after the transfer", async () => {
		stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(
				sequencedServer([
					okResponse(100n),
					okResponse(5n),
					okResponse(-5n),
					okResponse(6n),
				]),
			),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("negative");
	});

	// The distinct path: the read itself throws rather than returning an
	// unusable answer. The transfer applied, so the hash must survive.
	it("keeps the transaction hash when an after-read throws", async () => {
		stubSubmit(APPLIED);
		const result = await transferCheck.run(
			ctxWith(sequencedServer([okResponse(100n), okResponse(5n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("reading the balances afterwards failed");
		expect(result.evidence.txHash).toBe("abc123");
		expect(result.evidence.error).toContain("stub exhausted");
	});

	it("reports NOT_IMPLEMENTED when the spec declares no transfer", async () => {
		const ctx = ctxWith(sequencedServer([okResponse(100n)]));
		const result = await transferCheck.run({
			...ctx,
			specFunctions: ["balance", "decimals"],
		});
		expect(result.status).toBe("NOT_IMPLEMENTED");
		expect(result.layer).toBe("interface");
	});
});
