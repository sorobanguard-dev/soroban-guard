import {
	Account,
	Address,
	Keypair,
	Networks,
	nativeToScVal,
	type rpc,
	xdr,
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

/**
 * The ledger the stubbed writes settle in, and the one the canned reads
 * answer from: a live RPC answers a read after a write from that write's
 * ledger or later, and a read from before it is no answer (see `callRead`).
 */
export const WRITE_LEDGER = 4_738_627;

const BASE = {
	id: "unit-test",
	latestLedger: WRITE_LEDGER,
	events: [],
	_parsed: true,
} as const;

/**
 * A bigint is a SEP-41 quantity, and SEP-41 quantities are i128.
 * `nativeToScVal` would pick the smallest fitting type (u64 for 100n, i64
 * for -1n), which is exactly the wrong-type case the checks now FAIL, so
 * a test that wants another integer type passes an explicit ScVal.
 */
function encode(retval: xdr.ScVal | unknown): xdr.ScVal {
	if (typeof retval === "object" && retval !== null && "toXDR" in retval) {
		return retval as xdr.ScVal;
	}
	return typeof retval === "bigint"
		? nativeToScVal(retval, { type: "i128" })
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

/** Distinct XDR keys that cannot both be represented by a JS object key. */
export function collidingKeyMap(): xdr.ScVal {
	return xdr.ScVal.scvMap([
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvU32(1),
			val: xdr.ScVal.scvU32(10),
		}),
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol("1"),
			val: xdr.ScVal.scvU32(20),
		}),
	]);
}

/**
 * SET's `transfer(-1)`, a real refusal by trap, as testnet's RPC returned
 * it (captured 2026-11-23). The `error` carries only the primary error;
 * the evidence that `transfer` itself ran and trapped is in the events: a
 * `fn_call` naming it, then an `error` event from SET carrying the trap.
 */
const SET_TRAP = {
	error: "HostError: Error(WasmVm, InvalidAction)",
	events: [
		"AAAAAAAAAAAAAAAAAAAAAgAAAAAAAAADAAAADwAAAAdmbl9jYWxsAAAAAA0AAAAgwBYGKBpUc7cHJBZNmIhoekUc1vakMlyOU16qF0wiYVwAAAAPAAAACHRyYW5zZmVyAAAAEAAAAAEAAAADAAAAEgAAAAAAAAAA2ER7Qzfn3xNCiY8Aq97M/7RM9e1Y0VM0gt3dxPQD6jMAAAASAAAAAAAAAADl6Pqy26crVriXjdvd24Bt0IUAVAwmA5x9mrFbGpVNYQAAAAr/////////////////////",
		"AAAAAAAAAAAAAAABwBYGKBpUc7cHJBZNmIhoekUc1vakMlyOU16qF0wiYVwAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAEAAAAGAAAAEAAAAAEAAAACAAAADgAAACdWTSBjYWxsIHRyYXBwZWQ6IFVucmVhY2hhYmxlQ29kZVJlYWNoZWQAAAAADwAAAAh0cmFuc2Zlcg==",
	],
} as const;

/**
 * The TEST asset contract's `balance` of an address with no trustline, as
 * testnet's RPC returned it (captured 2026-11-23). The SAC's reason,
 * "trustline entry is missing for account", is only in the error event:
 * `error` itself names nothing but `Error(Contract, #13)`.
 */
const TEST_TRUSTLINE_MISSING = [
	"AAAAAAAAAAAAAAAAAAAAAgAAAAAAAAADAAAADwAAAAdmbl9jYWxsAAAAAA0AAAAgIwMRm4jlYGpRyNfljC4kLQPL/AuX2vtQugzHBQxF+4kAAAAPAAAAB2JhbGFuY2UAAAAAEgAAAAAAAAAA/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg=",
	"AAAAAAAAAAAAAAABIwMRm4jlYGpRyNfljC4kLQPL/AuX2vtQugzHBQxF+4kAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAANAAAAEAAAAAEAAAACAAAADgAAACZ0cnVzdGxpbmUgZW50cnkgaXMgbWlzc2luZyBmb3IgYWNjb3VudAAAAAAAEgAAAAAAAAAA/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg=",
] as const;

export function testTrustlineMissing(): rpc.Api.SimulateTransactionErrorResponse {
	return {
		...BASE,
		error: "HostError: Error(Contract, #13)",
		events: TEST_TRUSTLINE_MISSING.map((event) =>
			xdr.DiagnosticEvent.fromXdr(event, "base64"),
		),
	} as unknown as rpc.Api.SimulateTransactionErrorResponse;
}

/** A contract call, as a trace's call event names it. */
interface Invoked {
	/** The contract's 32-byte id. */
	readonly contract: Uint8Array;
	readonly method: string;
}

/** How a refusal rebuilds itself for another call (see `contractRefusal`). */
const REBUILD = Symbol("rebuild for the call asked");

/** The wire form of an error event, as far as a fixture changes it. */
interface ErrorWire {
	event: {
		contractId: Uint8Array | null;
		body: { v0: { topics: unknown[]; data: unknown } };
	};
}

/**
 * A contract refusing with `Error(Contract, #code)`, built from the TEST
 * capture's real events: TEST invoked, then an error event carrying the
 * code and `message`.
 *
 * `raisedBy` puts that error event in another contract, as when a token
 * passes on the refusal of a contract it called; `passedOn` then adds the
 * token's own event for the same error after it. `log` adds a log event
 * with that text before it, which must not count as the reason.
 * `calls` adds the token calling that other contract, and `unattributed`
 * drops the error event, so nothing says who raised the error.
 *
 * `invoked` names the call the trace answers in place of TEST's
 * `balance`: its contract makes the call and, unless `raisedBy` says
 * otherwise, raises the error. A stub server built by this module answers
 * each simulation with the refusal rebuilt for the call it was sent (see
 * `asAnswerTo`).
 */
export function contractRefusal(
	code: number,
	message?: string,
	options: {
		raisedBy?: Uint8Array;
		passedOn?: boolean;
		log?: string;
		calls?: Uint8Array;
		unattributed?: boolean;
		invoked?: Invoked;
	} = {},
): rpc.Api.SimulateTransactionErrorResponse {
	const {
		raisedBy,
		passedOn = false,
		log,
		calls,
		unattributed = false,
		invoked,
	} = options;
	const [captured, error] = TEST_TRUSTLINE_MISSING.map((event) =>
		xdr.DiagnosticEvent.fromXdr(event, "base64"),
	);
	if (captured === undefined || error === undefined) {
		throw new Error("fixture: TEST_TRUSTLINE_MISSING lost its events");
	}
	let call = captured;
	if (invoked !== undefined) {
		const named = captured.toXdrObject() as unknown as {
			event: {
				body: { v0: { topics: { bytes?: Uint8Array; sym?: string }[] } };
			};
		};
		const [, target, method] = named.event.body.v0.topics;
		if (target === undefined || method === undefined) {
			throw new Error("fixture: TEST_TRUSTLINE_MISSING's call lost its topics");
		}
		target.bytes = invoked.contract;
		method.sym = invoked.method;
		call = xdr.DiagnosticEvent.fromXdrObject(named as never);
	}
	const wire = error.toXdrObject() as unknown as ErrorWire;
	wire.event.body.v0.topics = [
		{ type: 15, sym: "error" },
		{ type: 2, error: { type: 0, contractCode: code } },
	];
	wire.event.body.v0.data = {
		type: 16,
		vec: message === undefined ? [] : [{ type: 14, str: message }],
	};
	const token = invoked?.contract ?? wire.event.contractId;
	wire.event.contractId = raisedBy ?? token;
	const events = [call];
	if (calls !== undefined) {
		const inner = call.toXdrObject() as unknown as {
			event: { body: { v0: { topics: { bytes?: Uint8Array }[] } } };
		};
		const target = inner.event.body.v0.topics[1];
		if (target !== undefined) target.bytes = calls;
		events.push(xdr.DiagnosticEvent.fromXdrObject(inner as never));
	}
	if (log !== undefined) {
		const logged = error.toXdrObject() as unknown as ErrorWire;
		logged.event.contractId = token;
		logged.event.body.v0.topics = [{ type: 15, sym: "log" }];
		logged.event.body.v0.data = { type: 14, str: log };
		events.push(xdr.DiagnosticEvent.fromXdrObject(logged as never));
	}
	if (!unattributed) {
		events.push(xdr.DiagnosticEvent.fromXdrObject(wire as never));
	}
	if (passedOn) {
		wire.event.contractId = token;
		events.push(xdr.DiagnosticEvent.fromXdrObject(wire as never));
	}
	const response = {
		...BASE,
		error: `HostError: Error(Contract, #${code})`,
		events,
	};
	// Not enumerable: a test that spreads the response into its own keeps
	// the trace exactly as built.
	Object.defineProperty(response, REBUILD, {
		value: (asked: Invoked) =>
			contractRefusal(code, message, { ...options, invoked: asked }),
	});
	return response as unknown as rpc.Api.SimulateTransactionErrorResponse;
}

/** The contract call a simulated transaction makes, when it makes one. */
function invokedBy(tx: unknown): Invoked | undefined {
	const operation = (tx as { operations?: readonly unknown[] } | undefined)
		?.operations?.[0] as
		| {
				func?: {
					invokeContract?: {
						contractAddress: xdr.ScAddress;
						functionName: unknown;
					};
				};
		  }
		| undefined;
	const invocation = operation?.func?.invokeContract;
	return invocation === undefined
		? undefined
		: {
				contract: Address.fromScAddress(invocation.contractAddress).toBuffer(),
				method: String(invocation.functionName),
			};
}

/**
 * `response` with `fields` in place of its own, still rebuilt for the call
 * it answers when it is a refusal from `contractRefusal`: a spread copy
 * would answer every call with TEST's `balance`.
 */
export function withFields<T extends object>(response: T, fields: object): T {
	const copy = { ...response, ...fields };
	const rebuild = (response as { [REBUILD]?: (asked: Invoked) => T })[REBUILD];
	if (rebuild !== undefined) {
		Object.defineProperty(copy, REBUILD, {
			value: (asked: Invoked) => ({ ...rebuild(asked), ...fields }),
		});
	}
	return copy;
}

/**
 * `response` as the answer to simulating `tx`: a refusal from
 * `contractRefusal` names the contract and method `tx` calls, as a real
 * trace would. Any other response is returned as it is.
 */
export function asAnswerTo<T>(tx: unknown, response: T): T {
	const rebuild = (
		response as { [REBUILD]?: (asked: Invoked) => T } | undefined
	)?.[REBUILD];
	const asked = invokedBy(tx);
	return rebuild === undefined || asked === undefined
		? response
		: rebuild(asked);
}

/** The parts of the trap event's wire form a test may change. */
export interface TrapWire {
	event: {
		/** 2 is a diagnostic event; 1 a contract event; 0 a system event. */
		type: number;
		contractId: Uint8Array | null;
		body: {
			v0: {
				topics: [unknown, { error: { type: number; code: number } }];
				data: { vec: [{ str: string }, { sym: string }] };
			};
		};
	};
}

/**
 * SET's captured trap as a simulation error, optionally altered: `change`
 * edits the trap event's wire form, and `events` picks which of the call
 * and trap events remain. Variants built this way stay real SDK objects.
 */
export function setTrap({
	error = SET_TRAP.error,
	change,
	events = "both",
	callType,
	alsoFailedIn,
	alsoFailedCode,
}: {
	error?: string;
	change?: (wire: TrapWire) => void;
	events?: "both" | "call" | "none";
	/** The `fn_call` event's type, to make it other than diagnostic. */
	callType?: number;
	/** Another contract whose VM also failed, recorded before the trap. */
	alsoFailedIn?: Uint8Array;
	/** That failure's ScErrorCode; 6, InvalidAction, unless given. */
	alsoFailedCode?: number;
} = {}): rpc.Api.SimulateTransactionErrorResponse {
	const [call, trap] = SET_TRAP.events.map((event) =>
		xdr.DiagnosticEvent.fromXdr(event, "base64"),
	);
	if (call === undefined || trap === undefined) {
		throw new Error("fixture: SET_TRAP lost its events");
	}
	const wire = trap.toXdrObject();
	change?.(wire as unknown as TrapWire);
	const altered = xdr.DiagnosticEvent.fromXdrObject(wire);
	const callWire = call.toXdrObject() as unknown as {
		event: { type: number };
	};
	if (callType !== undefined) {
		callWire.event.type = callType;
	}
	const invoked = xdr.DiagnosticEvent.fromXdrObject(callWire as never);
	const other = trap.toXdrObject() as unknown as TrapWire;
	if (alsoFailedIn !== undefined) {
		other.event.contractId = alsoFailedIn;
	}
	if (alsoFailedCode !== undefined) {
		other.event.body.v0.topics[1].error.code = alsoFailedCode;
	}
	const beside =
		alsoFailedIn === undefined
			? []
			: [xdr.DiagnosticEvent.fromXdrObject(other as never)];
	return {
		...BASE,
		error,
		events:
			events === "both"
				? [invoked, ...beside, altered]
				: events === "call"
					? [invoked]
					: [],
	} as unknown as rpc.Api.SimulateTransactionErrorResponse;
}

/**
 * A failed simulation's `error` as the RPC reports it: the primary host
 * error first, then the event log the host attaches. The primary error is
 * what the tool classifies, so a fixture states it the way the network
 * does rather than as bare text.
 */
export function hostError(primary: string, detail?: string): string {
	return detail === undefined
		? `HostError: ${primary}`
		: `HostError: ${primary}\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, ${primary}], data:"${detail}"`;
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
		simulateTransaction: async (tx: unknown) => {
			const response = responses[index];
			index += 1;
			if (response === undefined) {
				throw new Error(
					`stub exhausted: call ${index} of ${responses.length} planned`,
				);
			}
			return asAnswerTo(tx, response);
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
	ledger = WRITE_LEDGER,
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
	ledger: WRITE_LEDGER,
} as const;

/**
 * A refusal the contract itself issued, which is the common case under test.
 *
 * `settled: false` is the point: a rejection that reached the ledger and
 * died there is not attributable to the contract, and the negative check
 * reads exactly this flag to tell the two apart. Spelling it here keeps
 * every call site stating the case it means.
 */
export function rejected(
	diagnostics: string,
	reason: string = diagnostics,
): invoke.SubmitResult {
	// `reason` is the refusing event's message, what policy is recognised
	// from. Defaulted to the text, as the contract's own words in a test.
	return { kind: "rejected", diagnostics, settled: false, reason };
}
