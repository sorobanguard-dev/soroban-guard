import {
	Account,
	Address,
	BASE_FEE,
	hash,
	Keypair,
	nativeToScVal,
	Operation,
	rpc,
	scValToNative,
	type Transaction,
	TransactionBuilder,
	xdr,
} from "@stellar/stellar-sdk";
import {
	AssembledTransaction,
	type Signer,
} from "@stellar/stellar-sdk/contract";
import {
	classifySimulationFailure,
	describeSimulationFailure,
} from "./simulation.ts";

/**
 * Read path: simulate a contract call, decode the outcome.
 *
 * A trap is a result, not an exception — `interpretSimulation` maps it to
 * `{ kind: "trapped" }` so negative checks can assert on it. Only harness
 * failures (RPC down, malformed address) throw, and those propagate.
 */

// Validity window for simulated reads, where it does not matter: nothing
// is submitted.
const TX_TIMEOUT_S = 30;

/**
 * Upper bound on any single RPC request, in milliseconds.
 *
 * Without one, an RPC that accepts the connection and never answers holds
 * a run forever (the SDK applies `timeout` only since 17.3, and has no
 * default). Thirty seconds is far above a healthy testnet round trip.
 * Every `rpc.Server` the tool creates takes it, and writes reuse that
 * server.
 */
export const RPC_TIMEOUT_MS = 30_000;

/**
 * How long a written transaction stays valid, in seconds: long enough for
 * a person to approve it in a wallet.
 */
const WRITE_VALIDITY_S = 180;

/** How often a sent transaction is looked up while waiting for its outcome. */
const POLL_INTERVAL_MS = 2_000;

/** How long to keep looking once the validity window has closed, for the ledger to pass it. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * The longest a transaction is followed once sent, its last lookup
 * included, before its outcome is reported unknown. The envelope's own
 * deadline is not trusted for this: a signer could return one valid for
 * years, or forever.
 */
const MAX_FOLLOW_MS = WRITE_VALIDITY_S * 1000 + EXPIRY_MARGIN_MS;

/**
 * The span in which a sent transaction could be included. Proving it never
 * was needs this, so it travels with an unknown outcome and a later lookup
 * can apply the same proof.
 */
export interface InclusionWindow {
	/** The envelope's `maxTime`; 0 when it has none, which proves nothing. */
	readonly validUntil: number;
	/** The first ledger that could include it, when known (see `sendAndFollow`). */
	readonly earliestLedger?: number;
}

/** A ledger sequence as the RPC sends it: a positive safe integer. */
function ledgerInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

/**
 * A close time or time bound in seconds: a positive safe integer, or its
 * decimal string, which is how the RPC sends close times. Anything else
 * (missing, fractional, hex, exponent, infinite) is undefined.
 */
function unixSeconds(value: unknown): number | undefined {
	return typeof value === "string" && /^[1-9][0-9]*$/.test(value)
		? ledgerInteger(Number(value))
		: ledgerInteger(value);
}

/**
 * Whether a "not found" comes from past the window: the RPC's latest ledger
 * closed strictly after `validUntil`, so no later ledger can include the
 * transaction. The precondition for reading the ledger history (see
 * `lookupOutcome`); on its own it proves nothing, and whether the history
 * reaches back far enough is for the history's own answer to say.
 */
export function mayHaveExpired(
	seen: rpc.Api.GetTransactionResponse,
	window: InclusionWindow,
): boolean {
	if (seen.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
		return false;
	}
	const deadline = unixSeconds(window.validUntil);
	const latest = ledgerInteger(seen.latestLedger);
	const latestClose = unixSeconds(seen.latestLedgerCloseTime);
	return (
		deadline !== undefined &&
		latest !== undefined &&
		latestClose !== undefined &&
		latestClose > deadline
	);
}

/**
 * How far the walk through the ledger history has read for one
 * transaction, so a later lookup goes on from there instead of starting
 * over: closed ledgers do not change, so what has been read stays read.
 * Every ledger from `from` up to, not including, `next` has been read, and
 * none of them holds a receipt for the transaction. A walk only begins
 * once a lookup has seen the deadline pass, so progress also records
 * that, even before a ledger is read.
 */
export interface HistoryProgress {
	readonly txHash: string;
	/** The first ledger the walk read: the window's earliest. */
	readonly from: number;
	/** The ledger the walk reads next. */
	readonly next: number;
	/**
	 * One of those ledgers applied a result that cannot be identified, and
	 * could be the transaction: absence can no longer be proven, though a
	 * later receipt still settles it.
	 */
	readonly unidentified?: true;
}

/** What one lookup of a sent transaction establishes. */
export type Lookup =
	| { readonly kind: "applied"; readonly ledger: number }
	/** Included in a ledger, and failed there. */
	| { readonly kind: "failed"; readonly ledger?: number }
	/** Proven from the ledger history: it did not apply and never will. */
	| { readonly kind: "expired" }
	/**
	 * Not found yet, or the lookup itself failed: whether it applied is
	 * open. `progress`, when the history has been read, is where the next
	 * lookup goes on from.
	 *
	 * `closedAfterDeadline`, when set, is the RPC's latest ledger, which the
	 * RPC reports closed after the deadline (see `mayHaveExpired`): neither
	 * it nor any later ledger can include the transaction, so state from it
	 * on holds the transaction whichever way it went. An RPC-reported close
	 * only rules out a future inclusion; settling the outcome takes the
	 * ledgers' decoded headers and verified results (see `searchHistory`).
	 */
	| {
			readonly kind: "pending";
			readonly progress?: HistoryProgress;
			readonly closedAfterDeadline?: number;
	  };

/** A receipt the network gave: applied, or failed on the ledger. */
function receipt(
	seen: rpc.Api.GetTransactionResponse | undefined,
): Lookup | undefined {
	if (seen?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
		return { kind: "applied", ledger: seen.ledger };
	}
	if (seen?.status === rpc.Api.GetTransactionStatus.FAILED) {
		return seen.ledger === undefined
			? { kind: "failed" }
			: { kind: "failed", ledger: seen.ledger };
	}
	return undefined;
}

/**
 * How long one lookup may take, history included, when the caller sets no
 * deadline: long enough for a few pages at a healthy RPC's pace.
 */
const LOOKUP_BUDGET_MS = 60_000;

/**
 * Ledgers asked for per page of history. Each comes with its full
 * metadata, 0.2 to 0.6 MB on testnet in November 2026, so pages stay
 * small. A server that will not serve this many at once is asked for one.
 */
const LEDGERS_PER_PAGE = 5;

/**
 * Pages one lookup may read before returning `pending`, with its progress
 * for the next lookup to go on from. A 180-second window spans about 40
 * testnet ledgers: eight pages.
 */
const HISTORY_PAGES = 25;

/**
 * One transaction a ledger applied: the hashes it answers to, whether it
 * succeeded, and whether it may also answer to a hash that cannot be read.
 */
interface Applied {
	readonly hashes: readonly string[];
	readonly succeeded: boolean;
	readonly unreadable: boolean;
}

/**
 * One applied transaction, from its result pair. It answers to its own
 * hash and, for a fee bump, to the inner one, which is the one signed
 * here. Any code but `txSuccess` and a fee bump's inner success is a
 * failure. Under a code other than the four a ledger gives a plain or
 * fee-bumped transaction, a fee bump's inner hash is not carried, so the
 * pair could wrap the transaction being looked for; so could one whose
 * hash the SDK did not render as hex, which nothing here can compare.
 */
function appliedFrom(pair: xdr.TransactionResultPair): Applied {
	const outcome = pair.result.result;
	const rendered = [String(pair.transactionHash)];
	let succeeded = false;
	let innerUnread = false;
	if (outcome.type === "txSuccess" || outcome.type === "txFailed") {
		succeeded = outcome.type === "txSuccess";
	} else if (
		outcome.type === "txFeeBumpInnerSuccess" ||
		outcome.type === "txFeeBumpInnerFailed"
	) {
		rendered.push(String(outcome.innerResultPair.transactionHash));
		succeeded = outcome.type === "txFeeBumpInnerSuccess";
	} else {
		// Failed under a code that does not carry a fee bump's inner result:
		// its own hash still names it, but one it wraps cannot be read.
		innerUnread = true;
	}
	const hashes = rendered.filter((rendering) => HEX_HASH.test(rendering));
	return {
		hashes,
		succeeded,
		unreadable: innerUnread || hashes.length < rendered.length,
	};
}

/** A transaction hash as the network writes it, and as `toHex` renders one. */
const HEX_HASH = /^[0-9a-f]{64}$/;

/** Read only the complete transaction result set committed to by this header. */
function appliedIn(
	ledger: rpc.Api.GetLedgersResponse["ledgers"][number],
): Applied[] | undefined {
	const meta = ledger.metadataXdr;
	const close =
		meta?.type === "v2" ? meta.v2 : meta?.type === "v1" ? meta.v1 : meta?.v0;
	if (!Array.isArray(close?.txProcessing)) {
		return undefined;
	}
	try {
		if (
			close.ledgerHeader.toXdr("base64") !== ledger.headerXdr.toXdr("base64")
		) {
			return undefined;
		}
		const results = close.txProcessing.map((tx) => tx.result);
		const encoded = new xdr.TransactionResultSet({ results }).toXdr();
		if (
			toHex(hash(encoded)) === String(ledger.headerXdr.header.txSetResultHash)
		) {
			return results.map(appliedFrom);
		}
	} catch {
		// Unreadable XDR cannot establish absence.
	}
	return undefined;
}

/**
 * Walk the ledgers from the first that could include the transaction, each
 * from its own data: its decoded header for when it closed, its metadata
 * for every transaction it applied. The receipt is the first transaction
 * that answers to the hash. Absence is proven at the first ledger that
 * closed after the deadline: it and every later one closed too late to
 * hold the transaction, and every earlier one has been read.
 *
 * The header and its result-set hash must agree with the metadata.
 * Inside the window an unidentified result could be the signed
 * transaction, so absence cannot be proven past it; the walk still looks
 * for a receipt, which settles the outcome, since a transaction lands
 * once. A matching receipt after the deadline is contradictory.
 *
 * `resume` goes on from an earlier lookup's progress for the same
 * transaction and window.
 */
async function searchHistory(
	server: rpc.Server,
	txHash: string,
	window: InclusionWindow,
	until: number,
	resume: HistoryProgress | undefined,
): Promise<Lookup> {
	const deadline = unixSeconds(window.validUntil);
	const earliest = ledgerInteger(window.earliestLedger);
	if (deadline === undefined || earliest === undefined) {
		return { kind: "pending" };
	}
	const resumed =
		resume?.txHash === txHash &&
		resume.from === earliest &&
		(ledgerInteger(resume.next) ?? 0) >= earliest
			? resume
			: undefined;
	let next = resumed?.next ?? earliest;
	let unidentified = resumed?.unidentified === true;
	// Kept even before a ledger is read: that the walk began is itself the
	// record that a lookup saw the deadline pass (see `lookupOutcome`).
	const pending = (): Lookup => ({
		kind: "pending",
		progress: {
			txHash,
			from: earliest,
			next,
			...(unidentified ? { unidentified: true } : {}),
		},
	});
	for (let page = 0; page < HISTORY_PAGES; page += 1) {
		const start = next;
		// Asked for one ledger only when the server refused the page: a page
		// that ran out of time leaves no time for another.
		let refused = false;
		const read = (limit: number) =>
			before(until, () =>
				server
					.getLedgers({ startLedger: start, pagination: { limit } })
					.catch((error: unknown) => {
						refused = true;
						throw error;
					}),
			);
		const answer =
			(await read(LEDGERS_PER_PAGE)) ?? (refused ? await read(1) : undefined);
		const ledgers: unknown = answer?.ledgers;
		if (!Array.isArray(ledgers) || ledgers.length === 0) {
			return pending();
		}
		for (const ledger of ledgers as rpc.Api.GetLedgersResponse["ledgers"]) {
			const header = ledger?.headerXdr?.header;
			const closed =
				header === undefined
					? undefined
					: unixSeconds(String(header.scpValue?.closeTime));
			if (ledgerInteger(header?.ledgerSeq) !== next || closed === undefined) {
				return pending();
			}
			const applied = appliedIn(ledger);
			if (applied === undefined || performance.now() >= until) {
				return pending();
			}
			const found = applied.find((tx) => tx.hashes.includes(txHash));
			if (closed > deadline) {
				return found === undefined && !unidentified
					? { kind: "expired" }
					: pending();
			}
			// The receipt first: a verified result set that holds it settles
			// the outcome, whatever this or an earlier ledger applied besides.
			// Without one, a result that cannot be identified could be it.
			if (found !== undefined) {
				return found.succeeded
					? { kind: "applied", ledger: next }
					: { kind: "failed", ledger: next };
			}
			if (applied.some((tx) => tx.unreadable)) {
				unidentified = true;
			}
			next += 1;
		}
	}
	return pending();
}

/**
 * Look a sent transaction up. A failed lookup is `pending`, never an answer
 * from the contract, even when its message mentions `HostError`.
 *
 * A "not found" from a lookup by hash proves nothing alone: the RPC reads
 * the transaction before its ledger range, and servers behind one URL can
 * each miss a ledger that landed. Past the deadline, the ledgers' own
 * data decides (see `searchHistory`), going on from
 * `progress` when an earlier lookup of the same transaction left some:
 * that walk began past the deadline, so it goes on even when this lookup
 * by hash fails. A `pending` answer carries the progress forward, whether
 * or not this lookup read further, and names `closedAfterDeadline` when
 * this lookup saw the deadline pass.
 *
 * `until`, a `performance.now()` time, bounds the whole lookup: no request
 * starts after it, and an answer that comes later is not accepted. A
 * lookup made without one, such as the page's status check, gets
 * `LOOKUP_BUDGET_MS`.
 */
export async function lookupOutcome(
	server: rpc.Server,
	txHash: string,
	window: InclusionWindow | undefined,
	until: number = performance.now() + LOOKUP_BUDGET_MS,
	progress?: HistoryProgress,
): Promise<Lookup> {
	const seen = await before(until, () => server.getTransaction(txHash));
	const settled = receipt(seen);
	if (settled !== undefined) {
		return settled;
	}
	const closedAfterDeadline =
		seen !== undefined && window !== undefined && mayHaveExpired(seen, window)
			? seen.latestLedger
			: undefined;
	// A walk is only ever started past the deadline, so one under way goes
	// on whatever this lookup by hash says, or fails to.
	const underWay = progress?.txHash === txHash;
	if (
		window === undefined ||
		(closedAfterDeadline === undefined && !underWay)
	) {
		return progress === undefined
			? { kind: "pending" }
			: { kind: "pending", progress };
	}
	const found = await searchHistory(server, txHash, window, until, progress);
	return found.kind === "pending" && closedAfterDeadline !== undefined
		? { ...found, closedAfterDeadline }
		: found;
}

/** Polling knobs, overridable so tests do not wait in real time. */
export interface WriteTiming {
	readonly pollIntervalMs?: number;
	readonly giveUpAfterMs?: number;
	/** How long a simulation waits for a server behind `minLedger` (see `ReadCall`). */
	readonly catchUpMs?: number;
}

/**
 * How long a simulation waits for a server that is behind the ledger the
 * call needs, and how often it asks again: a backend behind a load
 * balancer is typically a ledger or two behind, about ten seconds.
 */
const CATCH_UP_MS = 20_000;
const CATCH_UP_POLL_MS = 1_000;

/**
 * Why a simulation answered from ledger `simulatedAt` cannot stand for the
 * state a call needs, or undefined when it can: it describes state from
 * before `minLedger`. A ledger that is not one says nothing about state.
 */
export function staleAnswer(
	simulatedAt: unknown,
	minLedger: number | undefined,
): string | undefined {
	if (minLedger === undefined) {
		return undefined;
	}
	const at = ledgerInteger(simulatedAt);
	return at !== undefined && at >= minLedger
		? undefined
		: `the RPC simulated this at ledger ${String(simulatedAt)}, before ledger ${minLedger}, whose state it had to reflect`;
}

/**
 * Ask until the answer is from `minLedger` or later. The first answer is
 * awaited like any request; asking again ends `catchUpMs` after it, with
 * each request bounded by what is left, so a slow one cannot stretch the
 * wait. One asked again that fails is asked again while time is left.
 * Returns the last answer either way, for the caller to judge with
 * `staleAnswer`.
 */
async function untilCaughtUp<T>(
	ask: () => Promise<T>,
	ledgerOf: (answer: T) => unknown,
	minLedger: number | undefined,
	timing: WriteTiming,
): Promise<T> {
	let answer = await ask();
	const giveUpAt = performance.now() + (timing.catchUpMs ?? CATCH_UP_MS);
	while (staleAnswer(ledgerOf(answer), minLedger) !== undefined) {
		const left = giveUpAt - performance.now();
		if (left <= 0) {
			return answer;
		}
		await new Promise((resolve) =>
			setTimeout(
				resolve,
				Math.min(timing.pollIntervalMs ?? CATCH_UP_POLL_MS, left),
			),
		);
		const again = await before(giveUpAt, ask);
		if (again !== undefined) {
			answer = again;
		}
	}
	return answer;
}

/** The outcome of sending a signed transaction and following it. */
export type SendOutcome =
	| {
			readonly kind: "applied";
			readonly txHash: string;
			readonly ledger: number;
	  }
	| {
			readonly kind: "failed";
			readonly txHash: string;
			readonly ledger?: number;
	  }
	/**
	 * The network declined it (ERROR, TRY_AGAIN_LATER), so it cannot apply.
	 * `result` is the decoded result code an ERROR came with, such as
	 * `txInsufficientFee` (see `declined`).
	 */
	| {
			readonly kind: "not-accepted";
			readonly txHash: string;
			readonly status: string;
			readonly result?: string;
	  }
	| { readonly kind: "expired"; readonly txHash: string }
	/**
	 * Unsettled when we stopped looking; `window` lets a later lookup settle
	 * it, going on from `progress` when the history was being read.
	 * `closedAfterDeadline` is the latest ledger a lookup saw close after the
	 * deadline (see `Lookup`), when one did.
	 */
	| {
			readonly kind: "unknown";
			readonly txHash: string;
			readonly window: InclusionWindow;
			readonly progress?: HistoryProgress;
			readonly closedAfterDeadline?: number;
	  };

/**
 * The envelope this process built for sending, and the latest ledger it
 * had seen before building it.
 */
export interface Prepared {
	readonly ledger: number;
	readonly transaction: Transaction;
}

/**
 * The answer to `request`, or undefined when it fails or `until` (a
 * `performance.now()` time) passes first. After `until`, no request starts
 * and a late answer is discarded; a request already sent is not cancelled.
 */
async function before<T>(
	until: number,
	request: () => Promise<T>,
): Promise<T | undefined> {
	const left = until - performance.now();
	if (left <= 0) {
		return undefined;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), left);
	});
	try {
		const answer = await Promise.race([request().catch(() => undefined), late]);
		// A timer can fire late, letting an answer win the race after `until`.
		return performance.now() >= until ? undefined : answer;
	} finally {
		clearTimeout(timer);
	}
}

/** A decoded XDR union: its arm's name, and that arm's fields. */
type Arm = { readonly type?: unknown; readonly [field: string]: unknown };

/**
 * The code a declined send's decoded `TransactionResult` carries, such as
 * `txInsufficientFee`. A failed transaction adds its operations' codes, and
 * a fee bump the code of the transaction inside it. Undefined when there is
 * no result to read.
 */
function resultCode(result: unknown): string | undefined {
	const outcome = (result as { readonly result?: Arm } | undefined)?.result;
	if (typeof outcome?.type !== "string") {
		return undefined;
	}
	const inner =
		outcome.type === "txFeeBumpInnerFailed"
			? [
					resultCode(
						(
							outcome.innerResultPair as
								| { readonly result?: unknown }
								| undefined
						)?.result,
					),
				]
			: outcome.type === "txFailed" && Array.isArray(outcome.results)
				? outcome.results.map(operationCode)
				: [];
	const named = inner.filter((code): code is string => code !== undefined);
	return named.length === 0
		? outcome.type
		: `${outcome.type} (${named.join(", ")})`;
}

/**
 * One operation's result code: the operation's own, such as
 * `invokeHostFunctionTrapped`, or the outer one, such as `opBadAuth`.
 */
function operationCode(operation: unknown): string | undefined {
	const arm = operation as Arm | undefined;
	if (typeof arm?.type !== "string") {
		return undefined;
	}
	if (arm.type !== "opInner") {
		return arm.type;
	}
	const tr = arm.tr as Arm | undefined;
	const own = Object.entries(tr ?? {}).find(
		([field, value]) =>
			field !== "type" && typeof (value as Arm | undefined)?.type === "string",
	)?.[1] as Arm | undefined;
	return typeof own?.type === "string"
		? own.type
		: typeof tr?.type === "string"
			? tr.type
			: undefined;
}

/**
 * Why the network declined a transaction, for an error message: its status,
 * with the result code when it gave one, as in "ERROR: txInsufficientFee".
 */
export function declined(outcome: {
	readonly status: string;
	readonly result?: string;
}): string {
	return outcome.result === undefined
		? outcome.status
		: `${outcome.status}: ${outcome.result}`;
}

/**
 * Send a prepared transaction and follow it until its outcome is known, or
 * for at most `MAX_FOLLOW_MS` once sent.
 *
 * The signed transaction must be the one prepared, and anything else is
 * refused before sending: a check would otherwise report on a call it
 * never made. The preparation ledger then bounds inclusion from below,
 * since an envelope built after a ledger cannot be in it or any earlier
 * one, unless the network answers DUPLICATE: it may have had the envelope
 * from before.
 */
export async function sendAndFollow(
	server: rpc.Server,
	signed: Transaction,
	prepared: Prepared,
	timing: WriteTiming = {},
): Promise<SendOutcome> {
	const txHash = toHex(signed.hash());
	if (toHex(prepared.transaction.hash()) !== txHash) {
		throw new Error(
			`the signer returned transaction ${txHash}, not the one prepared; nothing was sent`,
		);
	}
	const preparedAt = ledgerInteger(prepared.ledger);
	// A send request that fails may still have reached the network, so it
	// is followed like an accepted one.
	const sent = await server.sendTransaction(signed).catch(() => undefined);
	if (sent?.status === "ERROR" || sent?.status === "TRY_AGAIN_LATER") {
		const result =
			sent.status === "ERROR" ? resultCode(sent.errorResult) : undefined;
		return result === undefined
			? { kind: "not-accepted", txHash, status: sent.status }
			: { kind: "not-accepted", txHash, status: sent.status, result };
	}
	const window: InclusionWindow = {
		validUntil: Number(signed.timeBounds?.maxTime ?? 0),
		...(sent?.status !== "DUPLICATE" && preparedAt !== undefined
			? { earliestLedger: preparedAt + 1 }
			: {}),
	};
	const pollMs = timing.pollIntervalMs ?? POLL_INTERVAL_MS;
	const deadline = unixSeconds(window.validUntil);
	const untilExpiry =
		deadline === undefined ? 0 : Math.max(0, deadline * 1000 - Date.now());
	// The wall clock only sizes the budget, against the envelope's deadline;
	// a monotonic clock keeps it, so a clock change cannot stretch it.
	const giveUpAt =
		performance.now() +
		(timing.giveUpAfterMs ??
			Math.min(untilExpiry + EXPIRY_MARGIN_MS, MAX_FOLLOW_MS));
	// Each lookup goes on with the history where the one before stopped.
	let progress: HistoryProgress | undefined;
	// Only a lookup that saw the deadline pass sets it; progress alone does not.
	let closedAfterDeadline: number | undefined;
	const unknown = (): SendOutcome => ({
		kind: "unknown",
		txHash,
		window,
		...(progress === undefined ? {} : { progress }),
		...(closedAfterDeadline === undefined ? {} : { closedAfterDeadline }),
	});
	for (;;) {
		// Each lookup gets only the time left, so a slow last one cannot
		// carry the follow past its limit.
		const left = giveUpAt - performance.now();
		if (left <= 0) {
			return unknown();
		}
		const seen = await lookupOutcome(
			server,
			txHash,
			window,
			giveUpAt,
			progress,
		);
		if (seen.kind !== "pending") {
			return { ...seen, txHash };
		}
		progress = seen.progress;
		closedAfterDeadline = seen.closedAfterDeadline ?? closedAfterDeadline;
		const rest = giveUpAt - performance.now();
		if (rest <= 0) {
			return unknown();
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, rest)));
	}
}

/** Lowercase hex, as the network writes transaction hashes. Works in the browser too, where Node's Buffer does not exist. */
function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

/** A single read-only contract invocation. Args arrive pre-encoded as ScVals. */
export interface ReadCall {
	readonly contractId: string;
	readonly method: string;
	readonly args: readonly xdr.ScVal[];
	/**
	 * The oldest ledger whose state the simulation may describe, such as
	 * the latest one the caller has seen its own transactions settle in.
	 * Servers behind one URL can answer from a backend that has not reached
	 * it, and that answer describes state from before those transactions.
	 */
	readonly minLedger?: number;
}

export type InvokeResult =
	/**
	 * `type` is the ScVal type the contract actually returned. The decoded
	 * value alone cannot be trusted for conformance: `i32 7` and `u32 7`
	 * both decode to the number 7, `Symbol` and `String` to the same
	 * string, `u64` and `i128` to the same bigint.
	 */
	| {
			readonly kind: "ok";
			readonly value: unknown;
			readonly type: xdr.ScVal["type"];
	  }
	/** A returned ScVal exists, but the SDK cannot represent it natively. */
	| {
			readonly kind: "undecodable";
			readonly type: xdr.ScVal["type"];
			readonly diagnostics: string;
	  }
	| {
			readonly kind: "trapped";
			readonly diagnostics: string;
			/** The refusing error event's message, when it had one (see `SimulationFailure`). */
			readonly reason?: string;
	  }
	| { readonly kind: "restore"; readonly diagnostics: string }
	| { readonly kind: "inconclusive"; readonly diagnostics: string };

/**
 * Outcome of a submitted call. Distinct from `InvokeResult` because a write
 * either reached the ledger or it did not, and the difference is evidence:
 * `applied` carries the transaction hash and ledger a reviewer can look up
 * long after the events age out of RPC.
 *
 * `rejected` is either the contract's own code refusing the simulation, a
 * verdict, or, when `settled`, a transaction that failed on the ledger for
 * a cause the receipt does not give, which is not. `timeout` is us giving up
 * watching: the transaction may yet apply, so callers must map it to
 * UNVERIFIABLE rather than FAIL.
 */
export type SubmitResult =
	| {
			readonly kind: "applied";
			readonly txHash: string;
			readonly ledger: number;
	  }
	| {
			readonly kind: "rejected";
			readonly diagnostics: string;
			/**
			 * True when a transaction reached the ledger and failed there;
			 * false when the contract's own code refused the simulation.
			 *
			 * Only the second is attributable to the contract. A ledger
			 * failure can come from a fee, a sequence race or an expired
			 * footprint, so every check, positive or negative, reports it
			 * UNVERIFIABLE rather than as the contract's answer. A
			 * simulation whose trace does not show the contract refusing
			 * never arrives here: `submitWrite` throws it as a harness
			 * failure.
			 *
			 * A flag rather than a message match: the wording is produced
			 * here, and a caller sniffing it would break the moment it is
			 * reworded.
			 */
			readonly settled: boolean;
			/**
			 * For a refused simulation, the refusing error event's message, such
			 * as a Stellar Asset Contract's "trustline entry is missing for
			 * account". The asset's own policy is recognised from this alone,
			 * never from `diagnostics`, the whole trace, where a log can say
			 * anything.
			 */
			readonly reason?: string;
			/** Ledger used by a simulation that refused before submission. */
			readonly simulationLedger?: number;
			/**
			 * The transaction, when one reached the ledger to be looked up.
			 *
			 * Only a `settled` rejection has one: a refusal thrown at
			 * simulation never became a transaction. Carried as a field
			 * rather than left inside the diagnostics sentence, so a report
			 * can put it where a reader chases hashes instead of leaving it
			 * to be parsed out of prose.
			 */
			readonly txHash?: string;
			/** Ledger the failed transaction was included in, when known. */
			readonly ledger?: number;
	  }
	| { readonly kind: "restore"; readonly diagnostics: string }
	| {
			readonly kind: "timeout";
			readonly txHash: string;
			/**
			 * Lets a later `lookupOutcome` prove it never landed. `submitWrite`
			 * always sets it; without it, only a receipt settles the outcome.
			 */
			readonly window?: InclusionWindow;
			/** How far the history was read, for that lookup to go on from. */
			readonly progress?: HistoryProgress;
			/** A ledger seen to close after the deadline (see `Lookup`). */
			readonly closedAfterDeadline?: number;
	  };

/**
 * Encode a `C...`/`G...` address argument. Contract functions take ScVals,
 * never raw strings — a raw string encodes as an ScString and the call traps
 * on type mismatch.
 */
export function addressArg(address: string): xdr.ScVal {
	return Address.fromString(address).toScVal();
}

/**
 * Encode an amount argument. SEP-41 amounts are `i128`, which exceeds the
 * range JavaScript numbers represent exactly — so the input is `bigint` and
 * the width is stated rather than inferred. A bare number would encode as
 * 64-bit and the call would trap on type mismatch.
 */
export function amountArg(amount: bigint): xdr.ScVal {
	return nativeToScVal(amount, { type: "i128" });
}

/**
 * The largest amount `amountArg` can encode.
 *
 * Stated beside the encoder that enforces it rather than in the one check
 * that needs it: a caller computing an amount from ledger state has to know
 * where the encoder stops, and a second copy elsewhere is a second thing to
 * keep true. `nativeToScVal` throws above this, which would escape a check
 * as SKIPPED rather than as the honest "this cannot be tested".
 */
export const I128_MAX = 2n ** 127n - 1n;

/**
 * Encode a ledger-sequence argument. `approve` takes its expiration as a
 * `u32`, not the `i128` amounts use — passing an amount-encoded value there
 * traps on type mismatch, so the two encoders stay separate rather than
 * inferring a width from the number.
 */
export function ledgerArg(ledger: number): xdr.ScVal {
	if (!Number.isInteger(ledger) || ledger < 0 || ledger > 0xff_ff_ff_ff) {
		throw new RangeError(`ledger sequence out of u32 range: ${ledger}`);
	}
	return nativeToScVal(ledger, { type: "u32" });
}

/**
 * I/O half: build the invocation against `source` and simulate it. Returns
 * the raw simulation response — decoding is `interpretSimulation`'s job.
 *
 * `source` supplies the sequence number only; simulation spends nothing.
 * Re-fetch it before each real transaction — sequence is consumed even by
 * transactions that fail on-chain.
 *
 * With `call.minLedger`, an answer from an earlier ledger is asked again
 * for up to `catchUpMs`; the caller judges the answer it gets with
 * `staleAnswer`.
 */
export async function simulateRead(
	server: rpc.Server,
	source: Account,
	call: ReadCall,
	// Required, not defaulted. The passphrase is network identity, and a
	// default lets a caller that forgets it simulate against testnet while
	// the run reports another network — a wrong answer that nothing makes
	// loud. Every caller already passes it.
	networkPassphrase: string,
	timing: WriteTiming = {},
): Promise<rpc.Api.SimulateTransactionResponse> {
	const tx = new TransactionBuilder(source, {
		fee: BASE_FEE,
		networkPassphrase,
	})
		.addOperation(
			Operation.invokeContractFunction({
				contract: call.contractId,
				function: call.method,
				args: [...call.args],
			}),
		)
		.setTimeout(TX_TIMEOUT_S)
		.build();
	return untilCaughtUp(
		() => server.simulateTransaction(tx),
		(sim) => sim.latestLedger,
		call.minLedger,
		timing,
	);
}

/**
 * Pure half: map a simulation response to an `InvokeResult`. No I/O, fully
 * unit-testable against captured fixtures.
 *
 * Decoding notes: integers wider than 32 bits arrive as `bigint` (i128
 * balances included) — never coerce to `number`. A `void` return decodes to
 * `null` (there is no other null source). Restore responses are
 * success-shaped at runtime and carry the answer — reads decode it as `ok`
 * because reads never submit; only a restore *without* an answer reports
 * `restore`. Answerless success is partial RPC data, never a contract trap,
 * so it reports `inconclusive` and callers must not FAIL on it, and so is
 * a simulation that failed without the contract's own code refusing (see
 * `classifySimulationFailure`): only that refusal is `trapped`.
 * A native conversion failure preserves the returned XDR type: a suite
 * can reject an unexpected type without mistaking an SDK limitation on
 * the expected type for a contract defect.
 */
export function interpretSimulation(
	sim: rpc.Api.SimulateTransactionResponse,
): InvokeResult {
	if (rpc.Api.isSimulationError(sim)) {
		const diagnostics = describeSimulationFailure(sim);
		const failure = classifySimulationFailure(sim);
		if (!failure.byContract) {
			return { kind: "inconclusive", diagnostics };
		}
		return failure.reason === undefined
			? { kind: "trapped", diagnostics }
			: { kind: "trapped", diagnostics, reason: failure.reason };
	}
	if (rpc.Api.isSimulationSuccess(sim) && sim.result?.retval !== undefined) {
		const returned = sim.result.retval;
		try {
			return {
				kind: "ok",
				value: scValToNative(returned),
				type: returned.type,
			};
		} catch (error) {
			// Only conversion is guarded: RPC failures must still reach the
			// runner as harness errors. The raw type lets a check distinguish
			// a wrong return type from a decoder failing on the expected one.
			return {
				kind: "undecodable",
				type: returned.type,
				diagnostics: error instanceof Error ? error.message : String(error),
			};
		}
	}
	if (rpc.Api.isSimulationRestore(sim)) {
		return {
			kind: "restore",
			diagnostics:
				"no answer and archived entries need restoration before this call can execute",
		};
	}
	return {
		kind: "inconclusive",
		diagnostics: "simulation succeeded without a return value",
	};
}

/**
 * `server`, with `getAccount` answered from a ledger at `minLedger` or
 * later. The account entry is read with the ledger its answer describes,
 * asked again while that is earlier, and refused once it stays earlier:
 * a backend behind a settled write would hand back a sequence number that
 * write already used, and the network would decline the transaction as
 * `txBadSeq`. Every other method is the server's own.
 */
function accountsAt(
	server: rpc.Server,
	minLedger: number,
	timing: WriteTiming,
): rpc.Server {
	const getAccount = async (address: string): Promise<Account> => {
		const key = xdr.LedgerKey.account(
			new xdr.LedgerKeyAccount({
				accountId: Keypair.fromPublicKey(address).xdrPublicKey(),
			}),
		);
		const answer = await untilCaughtUp(
			() => server.getLedgerEntries(key),
			(entries) => entries.latestLedger,
			minLedger,
			timing,
		);
		const stale = staleAnswer(answer.latestLedger, minLedger);
		if (stale !== undefined) {
			throw new Error(
				`${stale}; the signer's sequence number could not be read, and nothing was sent`,
			);
		}
		const entry = answer.entries?.[0]?.val;
		if (entry?.type !== "account" || typeof entry.account.seqNum !== "bigint") {
			throw new Error(`no account entry for ${address}; nothing was sent`);
		}
		return new Account(address, entry.account.seqNum.toString());
	};
	return new Proxy(server, {
		get(target, property) {
			if (property === "getAccount") {
				return getAccount;
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export interface WriteCall extends ReadCall {
	/** Signs the transaction and any auth entry the contract demands. */
	readonly signer: Signer;
}

/**
 * Submit a contract call and wait for the ledger to settle it.
 *
 * The SDK simulates, assembles and signs; sending and following the
 * transaction is `sendAndFollow`, the same code every transaction the tool
 * sends goes through. A write costs a ledger close (~4-5s observed on
 * testnet), so a suite of them runs in minutes.
 *
 * A refusal is returned, not thrown: a contract rejecting a transfer is
 * exactly what a negative check asserts. Harness failures propagate, so
 * the runner records SKIPPED rather than a verdict we never earned. That
 * includes a transaction known not to have applied, because the network
 * declined it or it expired unincluded.
 */
export async function submitWrite(
	server: rpc.Server,
	call: WriteCall,
	networkPassphrase: string,
	timing: WriteTiming = {},
): Promise<SubmitResult> {
	// Before sending, nothing has left this process: the contract's own
	// refusal is a verdict and anything else a harness failure. After
	// sending, no error is the contract refusing; the question is only
	// whether it applied. An error while building propagates as it is.
	const assembled = await AssembledTransaction.build({
		contractId: call.contractId,
		method: call.method,
		args: [...call.args],
		rpcUrl: server.serverURL.toString(),
		// The caller's server, not one rebuilt from the URL: it carries the
		// request timeout (RPC_TIMEOUT_MS), which a fresh client would not.
		// Held to `minLedger`, it reads the signer's sequence from there too.
		server:
			call.minLedger === undefined
				? server
				: accountsAt(server, call.minLedger, timing),
		// The read server was built with the operator's --allow-http
		// consent; deriving the same permission from the same URL keeps the
		// write client from dropping it. Without this, local-node runs read
		// fine and every write SKIPs on the SDK's insecure endpoint refusal.
		allowHttp: server.serverURL.protocol === "http:",
		networkPassphrase,
		publicKey: call.signer.address,
		signTransaction: call.signer,
		parseResultXdr: (value: xdr.ScVal) => value,
		// Bounded, so a lost answer can be settled (see `lookupOutcome`).
		timeoutInSeconds: WRITE_VALIDITY_S,
		// Simulated below, where its ledger is checked.
		simulate: false,
	});
	// The simulation decides what is sent, and a refusal in it is a verdict.
	// One from before `minLedger` describes state from before transactions
	// the caller has seen, so it is asked again for a while, then given up on
	// as a harness failure. `simulate` does not throw on a failed simulation.
	// Each attempt simulates the envelope as first built: after a simulation,
	// the SDK keeps an envelope carrying the auth it recorded, which the RPC
	// would then enforce. Built once, since building moves the sequence on.
	const unassembled = assembled.raw?.build();
	const simulated = await untilCaughtUp(
		async () => {
			if (unassembled !== undefined) {
				assembled.built = unassembled;
			}
			await assembled.simulate();
			return assembled.simulation;
		},
		(simulation) => simulation?.latestLedger,
		call.minLedger,
		timing,
	);
	const stale = staleAnswer(simulated?.latestLedger, call.minLedger);
	if (stale !== undefined) {
		throw new Error(`${stale}; nothing was sent`);
	}
	try {
		// `sign` reads the simulation, so a refusal or archived state
		// surfaces here.
		await assembled.sign();
	} catch (error) {
		// By the SDK's error classes, never by message text: an RPC or
		// wallet error can mention "HostError" as easily as a simulation can.
		if (error instanceof AssembledTransaction.Errors.ExpiredState) {
			// A read reports the same situation as `restore`; it is not a
			// refusal.
			return { kind: "restore", diagnostics: error.message };
		}
		const simulation = assembled.simulation;
		if (
			error instanceof AssembledTransaction.Errors.SimulationFailed &&
			simulation !== undefined &&
			rpc.Api.isSimulationError(simulation)
		) {
			const failure = classifySimulationFailure(simulation);
			const diagnostics = describeSimulationFailure(simulation);
			if (failure.byContract) {
				const simulationLedger = ledgerInteger(simulation.latestLedger);
				return {
					kind: "rejected",
					diagnostics,
					settled: false,
					...(simulationLedger === undefined ? {} : { simulationLedger }),
					...(failure.reason === undefined ? {} : { reason: failure.reason }),
				};
			}
			throw new Error(
				`the simulation failed and its trace does not show the contract refusing (${failure.error ?? "no contract error was reported"}); nothing was sent. ${diagnostics}`,
			);
		}
		throw error;
	}
	const { built, signed, simulation } = assembled;
	if (built === undefined || signed === undefined || simulation === undefined) {
		throw new Error("signing produced no transaction to send");
	}
	// `built` is what the SDK handed the signer, after the simulation.
	const outcome = await sendAndFollow(
		server,
		signed,
		{ ledger: simulation.latestLedger, transaction: built },
		timing,
	);
	switch (outcome.kind) {
		case "applied":
			return {
				kind: "applied",
				txHash: outcome.txHash,
				ledger: outcome.ledger,
			};
		case "failed":
			// The receipt establishes failure on-chain. Attributing it to the
			// contract requires separate evidence.
			return {
				kind: "rejected",
				settled: true,
				txHash: outcome.txHash,
				...(outcome.ledger === undefined ? {} : { ledger: outcome.ledger }),
				diagnostics: `transaction ${outcome.txHash} failed on-chain`,
			};
		case "not-accepted":
			throw new Error(
				`the network did not accept transaction ${outcome.txHash} (${declined(outcome)})`,
			);
		case "expired":
			throw new Error(
				`transaction ${outcome.txHash} expired without being included in a ledger`,
			);
		case "unknown":
			return {
				kind: "timeout",
				txHash: outcome.txHash,
				window: outcome.window,
				...(outcome.progress === undefined
					? {}
					: { progress: outcome.progress }),
				...(outcome.closedAfterDeadline === undefined
					? {}
					: { closedAfterDeadline: outcome.closedAfterDeadline }),
			};
	}
}
