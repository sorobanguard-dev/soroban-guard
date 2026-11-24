import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
	addressArg,
	amountArg,
	interpretSimulation,
} from "../../../src/core/invoke.ts";
import {
	answerlessSuccess,
	collidingKeyMap,
	contractRefusal,
	errorResponse,
	hostError,
	okResponse,
	restoreResponse,
	setTrap,
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
			type: "scvU32",
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

	// A read can FAIL on `trapped`, so it is only the contract's own refusal.
	it("maps an error the contract raised to trapped, with diagnostics", () => {
		expect(interpretSimulation(contractRefusal(1, "refused"))).toEqual({
			kind: "trapped",
			reason: "refused",
			diagnostics: expect.stringContaining('data:["refused"]'),
		});
	});

	it("maps the invoked method trapping to trapped, with diagnostics", () => {
		expect(interpretSimulation(setTrap())).toEqual({
			kind: "trapped",
			reason: "VM call trapped: UnreachableCodeReached",
			// The events travel with it: they are the evidence of the trap.
			diagnostics: expect.stringContaining(
				'data:["VM call trapped: UnreachableCodeReached", transfer]',
			),
		});
	});

	// Anything else observed nothing, so it must not become a read FAIL.
	it.each([
		[
			"the host ran out of budget",
			errorResponse(hostError("Error(Budget, ExceededLimit)")),
		],
		["a VM error before the method ran", setTrap({ events: "none" })],
		["a failure with no host error", errorResponse("transaction is malformed")],
	])("maps a failure where %s to inconclusive", (_case, sim) => {
		expect(interpretSimulation(sim)).toMatchObject({ kind: "inconclusive" });
	});

	it("decodes a restore that carries an answer as ok", () => {
		// Restore responses are success-shaped at runtime: the preamble only
		// matters for submission, and reads never submit.
		expect(interpretSimulation(restoreResponse(xdr.ScVal.scvU32(7)))).toEqual({
			kind: "ok",
			value: 7,
			type: "scvU32",
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
			type: "scvVoid",
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
