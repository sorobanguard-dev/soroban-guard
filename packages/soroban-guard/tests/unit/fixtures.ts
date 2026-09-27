import {
	Account,
	Address,
	Keypair,
	Networks,
	nativeToScVal,
	type rpc,
	type xdr,
} from "@stellar/stellar-sdk";
import type { Signer } from "@stellar/stellar-sdk/contract";
import { vi } from "vitest";
import * as invoke from "../../src/core/invoke.ts";
import type { Sep41Context } from "../../src/sep41/context.ts";

// Canned simulation responses. Only the fields interpretSimulation reads
// are real (retval/error/preamble); the rest are inert placeholders. A bare
// JS number encodes as 64-bit (decodes to bigint), so pass an explicit ScVal
// (e.g. xdr.ScVal.scvU32) for exact contract types — exactly what the chain
// returns.

const BASE = {
	id: "unit-test",
	latestLedger: 1,
	events: [],
	_parsed: true,
} as const;

function encode(retval: xdr.ScVal | unknown): xdr.ScVal {
	return typeof retval === "object" && retval !== null && "toXDR" in retval
		? (retval as xdr.ScVal)
		: nativeToScVal(retval);
}

export function okResponse(
	retval: xdr.ScVal | unknown,
): rpc.Api.SimulateTransactionResponse {
	return {
		...BASE,
		transactionData: {},
		minResourceFee: "0",
		result: { auth: [], retval: encode(retval) },
	} as unknown as rpc.Api.SimulateTransactionResponse;
}

export function errorResponse(
	error: string,
): rpc.Api.SimulateTransactionResponse {
	return {
		...BASE,
		error,
	} as unknown as rpc.Api.SimulateTransactionResponse;
}

/** Success-shaped but answerless: partial RPC data, never a contract trap. */
export function answerlessSuccess(): rpc.Api.SimulateTransactionResponse {
	return {
		...BASE,
		transactionData: {},
		minResourceFee: "0",
		result: { auth: [] },
	} as unknown as rpc.Api.SimulateTransactionResponse;
}

export function restoreResponse(
	retval?: xdr.ScVal | unknown,
): rpc.Api.SimulateTransactionResponse {
	const base = retval === undefined ? answerlessSuccess() : okResponse(retval);
	return {
		...base,
		restorePreamble: { minResourceFee: "0", transactionData: {} },
	} as unknown as rpc.Api.SimulateTransactionResponse;
}

/**
 * A server stub that answers each simulation with the next canned response
 * in turn, so before/after reads can differ. Throws once exhausted:
 * replaying the last response would let a future extra read pass silently
 * against a stale answer. Each test states exactly the calls it expects,
 * so an unplanned one is a finding.
 */
export function sequencedServer(
	responses: readonly rpc.Api.SimulateTransactionResponse[],
): rpc.Server {
	let index = 0;
	return {
		simulateTransaction: async () => {
			const response = responses[index];
			index += 1;
			if (response === undefined) {
				throw new Error(
					`stub exhausted: call ${index} of ${responses.length} planned`,
				);
			}
			return response;
		},
	} as unknown as rpc.Server;
}

/**
 * Pin submitWrite's answer without touching the network — a real write
 * costs a ledger close. Returns the spy, so a test can also assert the
 * submission never happened, or inspect the arguments it was given.
 *
 * `vi.spyOn` patches the module for every later test in the file, so the
 * caller needs `vi.restoreAllMocks()` in an afterEach: a leaked stub
 * reaches cases that must never submit at all.
 */
export function stubSubmit(result: invoke.SubmitResult) {
	return vi.spyOn(invoke, "submitWrite").mockResolvedValue(result);
}

/**
 * A submission that reached the ledger and failed there — as opposed to a
 * simulation refusal, which never left the drawing board. The distinction
 * decides FAIL vs UNVERIFIABLE on every write path.
 */
export function settledFailure(
	diagnostics: string,
	/**
	 * The transaction that reached the ledger, defaulted because a settled
	 * failure has one by definition — it was included and then failed. A
	 * fixture without it would let a check drop the hash and still pass the
	 * test, which is exactly the gap that let six call sites lose it.
	 */
	txHash = "abc123",
	ledger = 4738627,
): invoke.SubmitResult {
	return { kind: "rejected", diagnostics, settled: true, txHash, ledger };
}

export const OWNER = Keypair.random().publicKey();
export const SPENDER = Keypair.random().publicKey();

export function signerFor(address: string): Signer {
	return { address } as unknown as Signer;
}

/**
 * A fully-signed context for write checks: both parties carry keys, so
 * tests opt *out* of signing authority (ownerSigns/spenderSigns) rather
 * than into it. Reads fixtures do the opposite and keep their own.
 */
export function writeCtx(
	server: rpc.Server,
	{ ownerSigns = true, spenderSigns = true } = {},
): Sep41Context {
	return {
		server,
		contractId: Address.contract(new Uint8Array(32)).toString(),
		source: new Account(OWNER, "1"),
		networkPassphrase: Networks.TESTNET,
		specFunctions: null,
		establishedAllowances: new Set(),
		soundness: {},
		parties: {
			owner: {
				address: OWNER,
				isThrowaway: false,
				signer: ownerSigns ? signerFor(OWNER) : undefined,
			},
			spender: {
				address: SPENDER,
				isThrowaway: false,
				signer: spenderSigns ? signerFor(SPENDER) : undefined,
			},
		},
	};
}

export const APPLIED = {
	kind: "applied",
	txHash: "abc123",
	ledger: 4738627,
} as const;

/**
 * A refusal the contract itself issued, which is the common case under test.
 *
 * `settled: false` is the point: a rejection that reached the ledger and
 * died there is not attributable to the contract, and the negative check
 * reads exactly this flag to tell the two apart. Spelling it here keeps
 * every call site stating the case it means.
 */
export function rejected(diagnostics: string): invoke.SubmitResult {
	return { kind: "rejected", diagnostics, settled: false };
}
