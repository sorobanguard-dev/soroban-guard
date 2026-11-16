import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import { SentTransaction } from "@stellar/stellar-sdk/contract";
import { describe, expect, it } from "vitest";
import {
	addressArg,
	amountArg,
	interpretSimulation,
	isContractOutcome,
} from "../../../src/core/invoke.ts";
import {
	answerlessSuccess,
	collidingKeyMap,
	errorResponse,
	okResponse,
	restoreResponse,
} from "../fixtures.ts";

describe("interpretSimulation", () => {
	it("preserves the raw type when the SDK cannot decode a returned value", () => {
		expect(interpretSimulation(okResponse(collidingKeyMap()))).toEqual({
			kind: "undecodable",
			type: "scvMap",
			diagnostics: expect.stringContaining("more than one key"),
		});
	});

	it("decodes a contract u32 return to a number", () => {
		expect(interpretSimulation(okResponse(xdr.ScVal.scvU32(7)))).toEqual({
			kind: "ok",
			value: 7,
		});
	});

	it("keeps wide ints as bigint, never number", () => {
		const result = interpretSimulation(okResponse(900_000_000n));
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(typeof result.value).toBe("bigint");
			expect(result.value).toBe(900_000_000n);
		}
	});

	it("maps a simulation error to trapped with diagnostics", () => {
		expect(
			interpretSimulation(errorResponse("host invocation trapped")),
		).toEqual({ kind: "trapped", diagnostics: "host invocation trapped" });
	});

	it("decodes a restore that carries an answer as ok", () => {
		// Restore responses are success-shaped at runtime: the preamble only
		// matters for submission, and reads never submit.
		expect(interpretSimulation(restoreResponse(xdr.ScVal.scvU32(7)))).toEqual({
			kind: "ok",
			value: 7,
		});
	});

	it("maps a restore without an answer to restore", () => {
		const result = interpretSimulation(restoreResponse());
		expect(result.kind).toBe("restore");
	});

	it("maps answerless success to inconclusive, never trapped", () => {
		// Partial RPC data is a harness anomaly, not a contract trap.
		// Mapping it to FAIL would accuse the contract of non-conformance.
		const result = interpretSimulation(answerlessSuccess());
		expect(result.kind).toBe("inconclusive");
	});

	it("decodes a void return to null", () => {
		expect(interpretSimulation(okResponse(xdr.ScVal.scvVoid()))).toEqual({
			kind: "ok",
			value: null,
		});
	});
});

describe("addressArg", () => {
	it("encodes a valid address", () => {
		const address = Keypair.random().publicKey();
		expect(addressArg(address)).toBeDefined();
	});

	it("rejects garbage", () => {
		expect(() => addressArg("NOT_AN_ADDRESS")).toThrow();
	});
});

describe("amountArg", () => {
	// Round-tripping is the real assertion: a bare JS number encodes as
	// 64-bit, and the contract call traps on the type mismatch. Decoding
	// back to the same bigint proves the declared i128 width survived.
	it("round-trips an i128 amount", () => {
		expect(scValToNative(amountArg(1n))).toBe(1n);
		expect(scValToNative(amountArg(10_000_000n))).toBe(10_000_000n);
	});

	it("declares i128, not a narrower integer type", () => {
		// SDK 17 models each ScVal arm as its own class, so the constructor
		// name is the discriminator. A bare number would arrive as ScValU64
		// here and trap at the contract boundary instead.
		expect(amountArg(1n).constructor.name).toBe("ScValI128");
	});

	// Beyond 2^64, so anything encoding at a narrower width loses data here.
	it("survives amounts wider than 64 bits", () => {
		const huge = 170141183460469231731687303715884105727n;
		expect(scValToNative(amountArg(huge))).toBe(huge);
	});

	it("encodes zero and negative amounts", () => {
		expect(scValToNative(amountArg(0n))).toBe(0n);
		expect(scValToNative(amountArg(-1n))).toBe(-1n);
	});
});

/**
 * This one predicate decides FAIL vs SKIPPED for every write the tool makes,
 * so both sides are pinned against the SDK's real wording rather than
 * paraphrases. The true cases come from AssembledTransaction's
 * SimulationFailed throw (`Transaction simulation failed: "<sim.error>"`),
 * one of them captured verbatim from a testnet run against a deauthorized
 * trustline. The false cases are the ways we fail to reach the ledger at
 * all — plus ExpiredState, which is a restore requirement rather than a
 * verdict and must not be read as one.
 */
describe("isContractOutcome", () => {
	it.each([
		'Transaction simulation failed: "HostError: Error(Contract, #11)"',
		'Transaction simulation failed: "HostError: Error(Contract, #13)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(Contract, #11)], data:"balance is deauthorized""',
		"HostError: Error(Contract, #7)",
	])("treats a completed simulation as the contract's own outcome: %s", (m) => {
		expect(isContractOutcome(m)).toBe(true);
	});

	it.each([
		["network unreachable", "fetch failed"],
		["connection refused", "Request failed: ECONNREFUSED"],
		[
			"restore required, not a verdict",
			"You need to restore some contract state before you can invoke this method.",
		],
		[
			"no signer configured",
			"NoSigner: You must provide a signTransaction function",
		],
		["insufficient fee reserve", "tx_insufficient_balance"],
		["stale sequence", "tx_bad_seq"],
	])("propagates a harness failure (%s)", (_label, message) => {
		expect(isContractOutcome(message)).toBe(false);
	});

	it("errs toward propagation on an unrecognised message", () => {
		// Conservative by design: an unknown failure costs a SKIPPED (exit 2,
		// "unknown") rather than a FAIL that accuses a conformant contract.
		expect(isContractOutcome("something nobody anticipated")).toBe(false);
	});
});

/**
 * Polling that ends without the transaction appearing throws
 * `TransactionStillPending` rather than returning a NOT_FOUND response, so
 * the timeout branch is reached by catching that class — not by inspecting a
 * result that never arrives. Pinned because the error's message is a JSON
 * dump of the send response: nothing should be parsing it, and without the
 * catch the union member is unreachable from real code.
 */
describe("TransactionStillPending", () => {
	it("is not mistaken for something the contract did", () => {
		const message =
			"Waited 30 seconds for transaction to complete, but it did not. " +
			"Returning anyway. Check the transaction status manually. " +
			'Sent transaction: { "status": "PENDING", "hash": "abc123" }';
		// Were this to match, a transaction that may yet apply would be
		// reported as the contract refusing.
		expect(isContractOutcome(message)).toBe(false);
	});

	it("is exported by the SDK, so it can be caught by class", () => {
		const error = new SentTransaction.Errors.TransactionStillPending("x");
		expect(error).toBeInstanceOf(
			SentTransaction.Errors.TransactionStillPending,
		);
	});
});
