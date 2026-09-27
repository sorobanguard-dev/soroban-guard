import {
	Account,
	Address,
	Keypair,
	Networks,
	type rpc,
	xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { allowanceCheck } from "../../../src/sep41/checks/allowance.ts";
import { balanceCheck } from "../../../src/sep41/checks/balance.ts";
import { decimalsCheck } from "../../../src/sep41/checks/decimals.ts";
import { nameCheck } from "../../../src/sep41/checks/name.ts";
import { symbolCheck } from "../../../src/sep41/checks/symbol.ts";
import type { Sep41Context } from "../../../src/sep41/context.ts";
import {
	answerlessSuccess,
	errorResponse,
	okResponse,
	restoreResponse,
} from "../fixtures.ts";

/**
 * Offline coverage for the SEP-41 read checks. The server is a stub returning
 * canned simulation responses, so the REAL check objects run end to end —
 * metadata, mapping branches, and value assertions — with zero network.
 * Live tests then only need to prove the wiring, not the logic.
 */
function stubServer(response: rpc.Api.SimulateTransactionResponse): rpc.Server {
	return {
		simulateTransaction: async () => response,
	} as unknown as rpc.Server;
}

function ctxWith(
	server: rpc.Server,
	specFunctions: readonly string[] | null = null,
	ownerIsThrowaway = false,
): Sep41Context {
	const owner = Keypair.random().publicKey();
	const spender = Keypair.random().publicKey();
	return {
		server,
		contractId: Address.contract(new Uint8Array(32)).toString(),
		source: new Account(owner, "1"),
		networkPassphrase: Networks.TESTNET,
		// Reads need identity only; no signer means write checks would
		// report UNVERIFIABLE, which is the correct state for a read fixture.
		parties: {
			owner: { address: owner, isThrowaway: ownerIsThrowaway },
			spender: { address: spender, isThrowaway: false },
		},
		specFunctions,
		establishedAllowances: new Set(),
		soundness: {},
	};
}

describe("decimalsCheck", () => {
	it("reports NOT_IMPLEMENTED under the interface layer when undeclared", async () => {
		const result = await decimalsCheck.run(
			ctxWith(stubServer(okResponse(xdr.ScVal.scvU32(7))), ["balance"]),
		);
		expect(result.status).toBe("NOT_IMPLEMENTED");
		expect(result.layer).toBe("interface");
		expect(result.actual).toContain("decimals");
	});

	it("passes on a sane u32 with metadata attached", async () => {
		const result = await decimalsCheck.run(
			ctxWith(stubServer(okResponse(xdr.ScVal.scvU32(7)))),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toBe("returned 7");
		expect(result.layer).toBe("interface");
		expect(result.requirement).toBe("required");
	});

	it("fails a trap with the diagnostic preserved", async () => {
		const result = await decimalsCheck.run(
			ctxWith(stubServer(errorResponse("host invocation trapped"))),
		);
		expect(result.status).toBe("FAIL");
		expect(result.evidence.error).toBe("host invocation trapped");
	});

	it("still fails a trap on a generated probe", async () => {
		// Narrowness lock: no-standing UNVERIFIABLE applies to balance and
		// allowance only. A decimals trap is genuine contract behavior even
		// when the probe is throwaway, so it stays FAIL.
		const result = await decimalsCheck.run(
			ctxWith(stubServer(errorResponse("host invocation trapped")), null, true),
		);
		expect(result.status).toBe("FAIL");
		expect(result.evidence.error).toBe("host invocation trapped");
	});

	it("reports UNVERIFIABLE when restoration is needed", async () => {
		const result = await decimalsCheck.run(
			ctxWith(stubServer(restoreResponse())),
		);
		expect(result.status).toBe("UNVERIFIABLE");
	});

	it("reports UNVERIFIABLE on answerless success, never FAIL", async () => {
		const result = await decimalsCheck.run(
			ctxWith(stubServer(answerlessSuccess())),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("no return value");
	});

	it("passes spec-legal values with the anomaly visible, not verdict-changing", async () => {
		// u32-ness is established by successful decode, so any u32 passes;
		// the bound survives only as warning text, since neither FAIL (false
		// accusation on spec-legal values) nor UNVERIFIABLE (the answer was
		// observed) is honest.
		const result = await decimalsCheck.run(
			ctxWith(stubServer(okResponse(xdr.ScVal.scvU32(100)))),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("outside plausible bounds");
	});

	it("fails a void return without calling it unexpected", async () => {
		const result = await decimalsCheck.run(
			ctxWith(stubServer(okResponse(xdr.ScVal.scvVoid()))),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("void");
	});
});

describe("balanceCheck", () => {
	it("passes on a non-negative bigint", async () => {
		const result = await balanceCheck.run(
			ctxWith(stubServer(okResponse(900_000_000n))),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toBe("balance is 900000000");
		expect(result.layer).toBe("behavior");
	});

	it("fails a wrong-typed value", async () => {
		const result = await balanceCheck.run(
			ctxWith(stubServer(okResponse(xdr.ScVal.scvU32(7)))),
		);
		expect(result.status).toBe("FAIL");
	});

	it("reports UNVERIFIABLE for zero on a generated probe", async () => {
		const server = stubServer(okResponse(0n));
		const result = await balanceCheck.run(ctxWith(server, null, true));
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("OWNER_ADDRESS");
	});

	it("passes zero for a configured owner", async () => {
		const result = await balanceCheck.run(
			ctxWith(stubServer(okResponse(0n)), null, false),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toBe("balance is 0");
	});

	it("reports UNVERIFIABLE for a missing-trustline trap", async () => {
		const server = stubServer(errorResponse("trustline entry is missing"));
		const result = await balanceCheck.run(ctxWith(server, null, true));
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("holds no trustline");
		expect(result.evidence.error).toBe("trustline entry is missing");
	});

	// Regression: this used to FAIL. Whether the address was generated or
	// supplied says nothing about standing — a real account that simply
	// does not hold the asset is the ordinary case, not a contract defect.
	it("is UNVERIFIABLE for a missing-trustline trap on a supplied owner", async () => {
		const result = await balanceCheck.run(
			ctxWith(stubServer(errorResponse("trustline entry is missing"))),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("holds no trustline");
	});

	it("is UNVERIFIABLE when the trustline exists but is deauthorized", async () => {
		const result = await balanceCheck.run(
			ctxWith(stubServer(errorResponse("balance is deauthorized"))),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("not authorized");
		// The remediation must match the cause: another address the reader
		// owns would fare no better, so it must not suggest one.
		expect(result.actual).toContain("issuer must authorize");
		expect(result.actual).not.toContain("point OWNER_ADDRESS");
	});

	// Classification follows the symptom, not the contract kind: a WASM
	// token reporting a missing trustline is describing the same standing
	// problem, so it is UNVERIFIABLE there too.
	it("classifies by the diagnostic, not by whether a spec was declared", async () => {
		const server = stubServer(errorResponse("trustline entry is missing"));
		const result = await balanceCheck.run(
			ctxWith(server, ["balance", "allowance"], true),
		);
		expect(result.status).toBe("UNVERIFIABLE");
	});

	it("still FAILs a trap that is genuine contract behavior", async () => {
		const server = stubServer(errorResponse("Error(Contract, #7)"));
		const result = await balanceCheck.run(ctxWith(server, null, true));
		expect(result.status).toBe("FAIL");
		expect(result.evidence.error).toBe("Error(Contract, #7)");
	});
});

describe("allowanceCheck", () => {
	it("passes on a non-negative bigint", async () => {
		const result = await allowanceCheck.run(
			ctxWith(stubServer(okResponse(0n))),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toBe("allowance is 0");
	});

	it("fails a trap with the diagnostic preserved", async () => {
		const result = await allowanceCheck.run(
			ctxWith(stubServer(errorResponse("no allowance entry"))),
		);
		expect(result.status).toBe("FAIL");
		expect(result.evidence.error).toBe("no allowance entry");
	});

	it("reports UNVERIFIABLE for zero on a generated probe", async () => {
		const server = stubServer(okResponse(0n));
		const result = await allowanceCheck.run(ctxWith(server, null, true));
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("OWNER_ADDRESS");
	});

	it("reports UNVERIFIABLE for a missing-trustline trap", async () => {
		const server = stubServer(errorResponse("trustline entry is missing"));
		const result = await allowanceCheck.run(ctxWith(server, null, true));
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("holds no trustline");
		expect(result.evidence.error).toBe("trustline entry is missing");
	});

	// Classification follows the symptom, not the contract kind.
	it("classifies by the diagnostic, not by whether a spec was declared", async () => {
		const server = stubServer(errorResponse("trustline entry is missing"));
		const result = await allowanceCheck.run(
			ctxWith(server, ["allowance"], true),
		);
		expect(result.status).toBe("UNVERIFIABLE");
	});

	it("still FAILs a trap that is genuine contract behavior", async () => {
		const server = stubServer(errorResponse("Error(Contract, #7)"));
		const result = await allowanceCheck.run(ctxWith(server, null, true));
		expect(result.status).toBe("FAIL");
		expect(result.evidence.error).toBe("Error(Contract, #7)");
	});
});

describe("nameCheck", () => {
	it("passes on a string with metadata attached", async () => {
		const result = await nameCheck.run(
			ctxWith(stubServer(okResponse("Test Token"))),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toBe('name is "Test Token"');
		expect(result.layer).toBe("interface");
		expect(result.requirement).toBe("required");
	});

	it("fails a non-string value", async () => {
		const result = await nameCheck.run(
			ctxWith(stubServer(okResponse(xdr.ScVal.scvU32(7)))),
		);
		expect(result.status).toBe("FAIL");
	});

	// SEP-41 declares `name() -> String` with no content requirement, so
	// FAILing an empty one invents a rule and accuses a conformant contract.
	// The anomaly is still worth seeing, so it rides in the message.
	it("passes an empty or blank name with the anomaly reported", async () => {
		for (const name of ["", "   "]) {
			const result = await nameCheck.run(ctxWith(stubServer(okResponse(name))));
			expect(result.status).toBe("PASS");
			expect(result.actual).toContain("empty");
		}
	});

	it("does not label a real name as empty", async () => {
		const result = await nameCheck.run(
			ctxWith(stubServer(okResponse("Comet Pool Token"))),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).not.toContain("empty");
	});

	it("still FAILs a non-string name", async () => {
		const result = await nameCheck.run(
			ctxWith(stubServer(okResponse(xdr.ScVal.scvU32(7)))),
		);
		expect(result.status).toBe("FAIL");
	});

	it("escapes control characters from contract metadata", async () => {
		const result = await nameCheck.run(
			ctxWith(stubServer(okResponse("A\n\x1b[31mB"))),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).not.toContain("\n");
		expect(result.actual).not.toContain("\x1b");
		expect(result.actual).toContain("\\n");
	});
});

describe("symbolCheck", () => {
	it("passes on a string", async () => {
		const result = await symbolCheck.run(
			ctxWith(stubServer(okResponse("TEST"))),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toBe('symbol is "TEST"');
	});

	it("reports NOT_IMPLEMENTED when undeclared", async () => {
		const result = await symbolCheck.run(
			ctxWith(stubServer(okResponse("TEST")), ["decimals"]),
		);
		expect(result.status).toBe("NOT_IMPLEMENTED");
	});

	it("passes an empty symbol with the anomaly reported", async () => {
		const result = await symbolCheck.run(ctxWith(stubServer(okResponse(""))));
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("empty");
	});

	it("still FAILs a non-string symbol", async () => {
		const result = await symbolCheck.run(
			ctxWith(stubServer(okResponse(xdr.ScVal.scvU32(7)))),
		);
		expect(result.status).toBe("FAIL");
	});
});
