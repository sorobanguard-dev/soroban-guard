import {
	Account,
	Keypair,
	Networks,
	rpc,
	type Transaction,
	xdr,
} from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	lookupOutcome,
	mayHaveExpired,
	sendAndFollow,
	simulateRead,
	staleAnswer,
	submitWrite,
} from "../../../src/core/invoke.ts";
import { ledgerResult, ledgerWithResults } from "../../fixtures/ledger.ts";
import {
	contractRefusal,
	errorResponse,
	hostError,
	setTrap,
} from "../fixtures.ts";

/**
 * What a write's outcome is, by the phase an error happens in.
 *
 * Before sending (build, sign) nothing has left the process: the
 * contract's own refusal is a verdict, anything else a harness failure. Once sent, no
 * error is the contract refusing. The transaction applied, failed on the
 * ledger, was not accepted, provably expired, or has an unknown outcome
 * that its hash and window can settle later.
 */
const SIGNED = new Uint8Array(32).fill(0xab);
const HASH = "ab".repeat(32);
const VALID_UNTIL = 1_000;
/** A follow that gives up almost at once, for tests that expect it to. */
const GIVES_UP = { pollIntervalMs: 0, giveUpAfterMs: 50 };
/**
 * A follow with time to spare, for tests that expect it to settle: a
 * worker that pauses must not turn their answer into a give-up.
 */
const SETTLES = { pollIntervalMs: 0, giveUpAfterMs: 30_000 };
/** The window of a fresh envelope prepared at ledger 120. */
const WINDOW = { validUntil: VALID_UNTIL, earliestLedger: 121 };

const call = {
	contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
	method: "transfer",
	args: [],
	signer: { address: Keypair.random().publicKey() },
} as unknown as Parameters<typeof submitWrite>[1];

type Seen = {
	status: string;
	ledger?: number;
	latestLedger?: unknown;
	latestLedgerCloseTime?: unknown;
	oldestLedger?: unknown;
	oldestLedgerCloseTime?: unknown;
};

/**
 * A ledger as `getLedgers` answers through the SDK: its decoded header and
 * metadata, and beside them the RPC's own summary.
 */
type Ledger = {
	sequence?: number;
	ledgerCloseTime?: string;
	headerXdr?: unknown;
	metadataXdr?: unknown;
};

/** Someone else's transaction, applied with `code`. */
function other(index = 0, code: "txSuccess" | "txBadSeq" = "txSuccess") {
	return ledgerResult(
		index.toString(16).padStart(64, "0"),
		code === "txSuccess"
			? xdr.TransactionResultResult.txSuccess([])
			: xdr.TransactionResultResult.txBadSeq(),
	);
}

/** Our transaction, applied with `code`. */
function ours(code: "txSuccess" | "txFailed" = "txSuccess") {
	return ledgerResult(HASH, xdr.TransactionResultResult[code]([]));
}

/** Our transaction, wrapped by someone in a fee bump: the pair has the outer hash. */
function feeBumped(code: "txFeeBumpInnerSuccess" | "txFeeBumpInnerFailed") {
	const innerResult = new xdr.InnerTransactionResultPair({
		transactionHash: SIGNED,
		result: new xdr.InnerTransactionResult({
			feeCharged: 0n,
			result:
				code === "txFeeBumpInnerSuccess"
					? xdr.InnerTransactionResultResult.txSuccess([])
					: xdr.InnerTransactionResultResult.txFailed([]),
			ext: xdr.InnerTransactionResultExt.v0(),
		}),
	});
	return ledgerResult(
		"fe".repeat(32),
		xdr.TransactionResultResult[code](innerResult),
	);
}

/** Ledger `sequence`, which closed at `closed` and applied `applied`. */
function ledger(
	sequence: number,
	closed: number,
	applied: xdr.TransactionResultPair[] = [other(sequence)],
) {
	return ledgerWithResults(sequence, closed, applied);
}

/**
 * A history without the transaction: up to ledger 139 inside the window,
 * each applying someone else's transaction, and from 140 on closed after
 * the deadline.
 */
function absent(sequence: number): Ledger {
	return ledger(sequence, sequence < 140 ? VALID_UNTIL - 50 : VALID_UNTIL + 5);
}

/**
 * Ledger 125 of an absent history whose decoded header reads `fields`
 * where they differ, while it still encodes as the header its metadata
 * carries: only the decoded fields can reject it.
 */
function decodedAs(fields: object): Ledger {
	const real = ledger(125, VALID_UNTIL - 50);
	return {
		...real,
		headerXdr: {
			...real.headerXdr,
			header: { ...real.headerXdr.header, ...fields },
			toXdr: (format?: "raw" | "hex" | "base64") =>
				real.headerXdr.toXdr(format as "base64"),
		},
	} as unknown as Ledger;
}

/** Ledger 124 applying `pair` beside someone else's, in an otherwise absent history. */
function with124(pair: xdr.TransactionResultPair, closed = VALID_UNTIL - 50) {
	return (sequence: number) =>
		sequence === 124 ? ledger(124, closed, [other(1), pair]) : absent(sequence);
}

/**
 * An RPC whose send, lookups and ledgers answer as each test needs.
 * `ledgers` gives each ledger by sequence: an Error fails a page that
 * starts there, and undefined ends a page there, as the RPC's newest
 * ledger does.
 */
function network({
	send = async () => ({ status: "PENDING", hash: HASH }),
	lookups = [],
	ledgers = absent,
}: {
	send?: () => Promise<unknown>;
	lookups?: (Seen | Error)[];
	ledgers?: (sequence: number) => Ledger | Error | undefined;
}) {
	let calls = 0;
	return {
		serverURL: new URL("https://rpc.example.invalid"),
		sendTransaction: vi.fn(send),
		getTransaction: vi.fn(async () => {
			const next = lookups[Math.min(calls, lookups.length - 1)];
			calls += 1;
			if (next === undefined || next instanceof Error) {
				throw next ?? new Error("no answer");
			}
			return next;
		}),
		getLedgers: vi.fn(
			async ({
				startLedger,
				pagination,
			}: {
				startLedger: number;
				pagination?: { limit?: number };
			}) => {
				const page: Ledger[] = [];
				for (let index = 0; index < (pagination?.limit ?? 50); index += 1) {
					const entry = ledgers(startLedger + index);
					if (entry instanceof Error) {
						if (index === 0) throw entry;
						break;
					}
					if (entry === undefined) break;
					page.push(entry);
				}
				if (page.length === 0) {
					throw new Error("start ledger is past the latest ledger");
				}
				return { ledgers: page };
			},
		),
	} as unknown as rpc.Server & {
		sendTransaction: ReturnType<typeof vi.fn>;
		getTransaction: ReturnType<typeof vi.fn>;
		getLedgers: ReturnType<typeof vi.fn>;
	};
}

/** The ledgers each `getLedgers` request started from, in order. */
function starts(server: ReturnType<typeof network>): number[] {
	return server.getLedgers.mock.calls.map(([request]) => request.startLedger);
}

/** Inside the window up to 125, and every page from 126 on fails. */
function failingFrom126(sequence: number): Ledger | Error {
	return sequence < 126 ? absent(sequence) : new Error("fetch failed");
}

const envelope = {
	hash: () => SIGNED,
	timeBounds: { minTime: "0", maxTime: String(VALID_UNTIL) },
} as unknown as Transaction;

/** A different transaction: what a signer might hand back instead. */
const otherEnvelope = {
	hash: () => new Uint8Array(32).fill(0xcd),
	timeBounds: { minTime: "0", maxTime: String(VALID_UNTIL) },
} as unknown as Transaction;

/** The envelope as this process prepared it, after ledger 120. */
const PREPARED = { ledger: 120, transaction: envelope };

/** The envelope as the SDK first builds it, before a simulation assembles it. */
const UNASSEMBLED = {
	hash: () => new Uint8Array(32).fill(0x11),
} as unknown as Transaction;

/**
 * A built transaction; `sign` can fail the way the SDK does. The signer
 * returns `envelope`, the one prepared, unless told otherwise, and
 * `simulation` is what the SDK simulates, then each of `later` in turn
 * when it simulates again.
 */
function built(
	sign: () => Promise<void> = async () => {},
	returned: Transaction = envelope,
	simulation: object | undefined = undefined,
	later: object[] = [],
) {
	const answers = [simulation ?? { latestLedger: 120 }, ...later];
	const fake = {
		built: envelope as Transaction | undefined,
		signed: undefined as unknown,
		simulation: undefined as object | undefined,
		// The SDK's builder: one envelope, before any simulation assembles it.
		raw: { build: vi.fn(() => UNASSEMBLED) },
		/** The envelope each simulation was sent. */
		simulated: [] as (Transaction | undefined)[],
		simulate: vi.fn(async () => {
			fake.simulated.push(fake.built);
			fake.simulation = answers.length > 1 ? answers.shift() : answers[0];
			// A simulation that succeeds leaves the assembled envelope behind.
			fake.built = envelope;
			return fake;
		}),
		sign: vi.fn(async () => {
			await sign();
			fake.signed = returned;
		}),
	};
	return vi
		.spyOn(AssembledTransaction, "build")
		.mockResolvedValue(fake as unknown as AssembledTransaction<never>);
}

/**
 * `built`, loading the signer's account on the server it is given before
 * it builds, as `AssembledTransaction.build` does. `loaded` holds each
 * account it read.
 */
function builtLoadingAccount(simulation: object) {
	const spy = built(async () => {}, envelope, simulation);
	const answer = spy.getMockImplementation();
	const loaded: Account[] = [];
	spy.mockImplementation(async (options) => {
		const { server, publicKey } = options as {
			server: rpc.Server;
			publicKey: string;
		};
		loaded.push(await server.getAccount(publicKey));
		return (answer as NonNullable<typeof answer>)(options);
	});
	return loaded;
}

const SUCCESS = { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 7 };
const NOT_FOUND_YET = {
	status: rpc.Api.GetTransactionStatus.NOT_FOUND,
	latestLedger: 150,
	latestLedgerCloseTime: String(VALID_UNTIL - 10),
	oldestLedger: 100,
	oldestLedgerCloseTime: "100",
};
/** Not found, past the window, with history reaching back to ledger 121. */
const PAST_WINDOW = {
	status: rpc.Api.GetTransactionStatus.NOT_FOUND,
	latestLedger: 200,
	latestLedgerCloseTime: String(VALID_UNTIL + 5),
	oldestLedger: 121,
	oldestLedgerCloseTime: "100",
};

/** `sign` failing the way the SDK fails it when `simulation` errored. */
function refusing(simulation: { error: string }) {
	return async () => {
		throw new AssembledTransaction.Errors.SimulationFailed(
			`Transaction simulation failed: "${simulation.error}"`,
		);
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("submitWrite, before sending", () => {
	it.each([
		["an error the contract raised", contractRefusal(1)],
		["the invoked method trapping", setTrap()],
	])("reports %s as rejected, without sending", async (_case, simulation) => {
		built(refusing(simulation as { error: string }), envelope, simulation);
		const server = network({});
		await expect(
			submitWrite(server, call, Networks.TESTNET, SETTLES),
		).resolves.toMatchObject({ kind: "rejected", settled: false });
		expect(server.sendTransaction).not.toHaveBeenCalled();
	});

	// A refusal says which ledger's state refused, so a check can relate it
	// to the reads it judges the refusal by.
	it("names the ledger a refusing simulation ran at", async () => {
		const refusal = { ...contractRefusal(1), latestLedger: 4321 };
		built(refusing(refusal), envelope, refusal);
		await expect(
			submitWrite(network({}), call, Networks.TESTNET, SETTLES),
		).resolves.toMatchObject({ kind: "rejected", simulationLedger: 4321 });
	});

	// A simulation can fail without the contract refusing. Read as a refusal,
	// a negative check would PASS it and a positive one FAIL it; it is
	// neither, so it stays a harness failure, which names the host's error.
	it.each([
		[
			"the host ran out of budget",
			errorResponse(hostError("Error(Budget, ExceededLimit)")),
			"Error(Budget, ExceededLimit)",
		],
		[
			"the VM failed before the method ran",
			setTrap({ events: "none" }),
			"Error(WasmVm, InvalidAction)",
		],
		[
			"a contract error appears only in the log",
			errorResponse(
				hostError("Error(Budget, ExceededLimit)", "Error(Contract, #4)"),
			),
			"Error(Budget, ExceededLimit)",
		],
		[
			"the host required an authorization",
			errorResponse(hostError("Error(Auth, InvalidAction)")),
			"Error(Auth, InvalidAction)",
		],
	])(
		"propagates a failure where %s, without sending",
		async (_case, simulation, named) => {
			built(refusing(simulation as { error: string }), envelope, simulation);
			const server = network({});
			await expect(
				submitWrite(server, call, Networks.TESTNET, SETTLES),
			).rejects.toThrow(
				`the simulation failed and its trace does not show the contract refusing (${named})`,
			);
			expect(server.sendTransaction).not.toHaveBeenCalled();
		},
	);

	// Sending what the signer returned instead would report on a call this
	// check never made.
	it("refuses to send a transaction other than the one prepared", async () => {
		built(async () => {}, otherEnvelope);
		const server = network({ lookups: [SUCCESS] });
		await expect(
			submitWrite(server, call, Networks.TESTNET, SETTLES),
		).rejects.toThrow("not the one prepared; nothing was sent");
		expect(server.sendTransaction).not.toHaveBeenCalled();
	});

	it("reports archived state as restore", async () => {
		built(async () => {
			throw new AssembledTransaction.Errors.ExpiredState("restore first");
		});
		await expect(
			submitWrite(network({}), call, Networks.TESTNET, SETTLES),
		).resolves.toMatchObject({ kind: "restore" });
	});

	// Only the SDK's SimulationFailed is a refusal. Wording is not evidence:
	// a negative check credits a refusal as PASS, so a setup or wallet error
	// that happens to mention HostError must stay a harness failure.
	it.each([
		["an RPC error while building", "build"],
		["a wallet error while signing", "sign"],
		// Even beside a simulation the contract did refuse: only the SDK's
		// own refusal error carries that verdict, never another error.
		["a wallet error beside a refused simulation", "sign-refused"],
	])("propagates %s, even one mentioning HostError", async (_case, phase) => {
		const error = new Error("HostError: Error(Contract, #1)");
		if (phase === "build") {
			vi.spyOn(AssembledTransaction, "build").mockRejectedValue(error);
		} else {
			built(
				async () => {
					throw error;
				},
				envelope,
				phase === "sign-refused" ? contractRefusal(1) : undefined,
			);
		}
		const server = network({});
		await expect(
			submitWrite(server, call, Networks.TESTNET, SETTLES),
		).rejects.toBe(error);
		expect(server.sendTransaction).not.toHaveBeenCalled();
	});

	it("propagates a harness failure before anything was sent", async () => {
		built(async () => {
			throw new AssembledTransaction.Errors.NoSigner("no signer");
		});
		await expect(
			submitWrite(network({}), call, Networks.TESTNET, SETTLES),
		).rejects.toThrow("no signer");
	});

	// The simulation decides what is sent, and a refusal in it is a verdict.
	// One from before the ledger the caller needs describes state from
	// before transactions the caller has seen.
	// After a simulation the SDK keeps an envelope carrying the auth it
	// recorded, and the RPC enforces auth it is sent. Each attempt is the
	// envelope as first built, which is built once: building again would
	// move the sequence on.
	it("simulates the envelope as first built on every attempt", async () => {
		const spy = built(async () => {}, envelope, { latestLedger: 129 }, [
			{ latestLedger: 130 },
		]);
		await submitWrite(
			network({ lookups: [SUCCESS] }),
			{ ...call, minLedger: 130 },
			Networks.TESTNET,
			SETTLES,
		);
		const assembled = await spy.mock.results[0]?.value;
		expect(assembled.simulated).toEqual([UNASSEMBLED, UNASSEMBLED]);
		expect(assembled.raw.build).toHaveBeenCalledOnce();
	});

	/** An account entry as `getLedgerEntries` answers it from `ledger`. */
	function accountAt(sequence: bigint, ledger: number) {
		return {
			latestLedger: ledger,
			entries: [{ val: { type: "account", account: { seqNum: sequence } } }],
		};
	}

	// A backend behind a settled write would hand back a sequence number
	// that write already used, so the network would decline the next one.
	it("reads the signer's sequence from a ledger at the floor", async () => {
		const loaded = builtLoadingAccount({ latestLedger: 130 });
		const server = Object.assign(network({ lookups: [SUCCESS] }), {
			getLedgerEntries: vi
				.fn()
				.mockResolvedValueOnce(accountAt(40n, 129))
				.mockResolvedValue(accountAt(41n, 130)),
		});
		await expect(
			submitWrite(
				server,
				{ ...call, minLedger: 130 },
				Networks.TESTNET,
				SETTLES,
			),
		).resolves.toMatchObject({ kind: "applied" });
		expect(loaded.map((account) => account.sequenceNumber())).toEqual(["41"]);
		expect(server.getLedgerEntries).toHaveBeenCalledTimes(2);
		// Everything else is the caller's own server.
		const options = vi.mocked(AssembledTransaction.build).mock
			.calls[0]?.[0] as {
			server: rpc.Server;
		};
		expect(options.server.serverURL).toBe(server.serverURL);
	});

	// The build reads the sequence before anything is simulated or signed,
	// so a stale one stops the write there.
	it("refuses a sequence number that stays behind the floor, and sends nothing", async () => {
		const loaded = builtLoadingAccount({ latestLedger: 130 });
		const server = Object.assign(network({ lookups: [SUCCESS] }), {
			getLedgerEntries: vi.fn().mockResolvedValue(accountAt(40n, 129)),
		});
		await expect(
			submitWrite(server, { ...call, minLedger: 130 }, Networks.TESTNET, {
				...SETTLES,
				catchUpMs: 20,
			}),
		).rejects.toThrow(
			"the signer's sequence number could not be read, and nothing was sent",
		);
		expect(loaded).toEqual([]);
		expect(server.sendTransaction).not.toHaveBeenCalled();
	});

	it("reads the sequence as the SDK does when nothing holds the write to a ledger", async () => {
		const spy = built();
		const server = network({ lookups: [SUCCESS] });
		await submitWrite(server, call, Networks.TESTNET, SETTLES);
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ server });
	});

	it("simulates again until the simulation is from the ledger it needs", async () => {
		const spy = built(async () => {}, envelope, { latestLedger: 129 }, [
			{ latestLedger: 130 },
		]);
		await expect(
			submitWrite(
				network({ lookups: [SUCCESS] }),
				{ ...call, minLedger: 130 },
				Networks.TESTNET,
				SETTLES,
			),
		).resolves.toMatchObject({ kind: "applied" });
		const assembled = await spy.mock.results[0]?.value;
		expect(assembled.simulate).toHaveBeenCalledTimes(2);
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ simulate: false });
	});

	it("sends nothing, and credits no refusal, from a simulation that stays behind", async () => {
		const refusal = { ...contractRefusal(1), latestLedger: 129 };
		built(refusing(refusal), envelope, refusal);
		const server = network({});
		await expect(
			submitWrite(server, { ...call, minLedger: 130 }, Networks.TESTNET, {
				pollIntervalMs: 0,
				catchUpMs: 20,
			}),
		).rejects.toThrow(
			"the RPC simulated this at ledger 129, before ledger 130, whose state it had to reflect; nothing was sent",
		);
		expect(server.sendTransaction).not.toHaveBeenCalled();
	});

	it("hands the caller's bounded server to the transaction builder", async () => {
		const spy = built();
		const server = network({ lookups: [SUCCESS] });
		await submitWrite(server, call, Networks.TESTNET, SETTLES);
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ server });
	});
});

describe("submitWrite, once sent", () => {
	it("returns applied with the signed hash when the transaction lands", async () => {
		built();
		await expect(
			submitWrite(
				network({ lookups: [NOT_FOUND_YET, SUCCESS] }),
				call,
				Networks.TESTNET,
				SETTLES,
			),
		).resolves.toEqual({ kind: "applied", txHash: HASH, ledger: 7 });
	});

	it("reports a ledger failure as settled, with the hash", async () => {
		built();
		await expect(
			submitWrite(
				network({
					lookups: [{ status: rpc.Api.GetTransactionStatus.FAILED, ledger: 8 }],
				}),
				call,
				Networks.TESTNET,
				SETTLES,
			),
		).resolves.toEqual({
			kind: "rejected",
			settled: true,
			txHash: HASH,
			ledger: 8,
			diagnostics: `transaction ${HASH} failed on-chain`,
		});
	});

	// The request may have arrived before it failed.
	it("reports an unknown outcome, with the hash, when the send request fails", async () => {
		built();
		await expect(
			submitWrite(
				network({
					send: async () => {
						throw new TypeError("fetch failed");
					},
				}),
				call,
				Networks.TESTNET,
				GIVES_UP,
			),
		).resolves.toEqual({ kind: "timeout", txHash: HASH, window: WINDOW });
	});

	// A failed send request is followed, so one that did arrive settles...
	it("settles a failed send request that did reach the network", async () => {
		built();
		await expect(
			submitWrite(
				network({
					send: async () => {
						throw new TypeError("fetch failed");
					},
					lookups: [NOT_FOUND_YET, SUCCESS],
				}),
				call,
				Networks.TESTNET,
				SETTLES,
			),
		).resolves.toEqual({ kind: "applied", txHash: HASH, ledger: 7 });
	});

	// ...and one that never arrived is proven not applied once its window
	// passes, so a caller can send again instead of waiting forever.
	it("proves a failed send request never landed once its window passes", async () => {
		built();
		await expect(
			submitWrite(
				network({
					send: async () => {
						throw new TypeError("fetch failed");
					},
					lookups: [PAST_WINDOW],
				}),
				call,
				Networks.TESTNET,
				SETTLES,
			),
		).rejects.toThrow("expired without being included");
	});

	// DUPLICATE: the network already has it, so it may still apply.
	it("follows a DUPLICATE send like a pending one", async () => {
		built();
		await expect(
			submitWrite(
				network({
					send: async () => ({ status: "DUPLICATE", hash: HASH }),
					lookups: [SUCCESS],
				}),
				call,
				Networks.TESTNET,
				SETTLES,
			),
		).resolves.toMatchObject({ kind: "applied", txHash: HASH });
	});

	// The network may have had a DUPLICATE from before this run prepared it,
	// so the preparation ledger is no lower bound and nothing is proven.
	it("never proves a DUPLICATE expired from the preparation ledger", async () => {
		built();
		await expect(
			submitWrite(
				network({
					send: async () => ({ status: "DUPLICATE", hash: HASH }),
					lookups: [PAST_WINDOW],
				}),
				call,
				Networks.TESTNET,
				GIVES_UP,
			),
		).resolves.toEqual({
			kind: "timeout",
			txHash: HASH,
			window: { validUntil: VALID_UNTIL },
		});
	});

	it.each(["ERROR", "TRY_AGAIN_LATER"])(
		"treats a %s send as known not applied, not unknown",
		async (status) => {
			built();
			const server = network({ send: async () => ({ status, hash: HASH }) });
			await expect(
				submitWrite(server, call, Networks.TESTNET, SETTLES),
			).rejects.toThrow(status);
			expect(server.getTransaction).not.toHaveBeenCalled();
		},
	);

	// A polling error is never the contract's answer, whatever its text.
	it("names the result code in the harness failure for a declined send", async () => {
		built();
		await expect(
			submitWrite(
				network({
					send: async () => ({
						status: "ERROR",
						hash: HASH,
						errorResult: xdr.TransactionResult.fromXdr(
							"AAAAAAAAAGT////3AAAAAA==",
							"base64",
						),
					}),
				}),
				call,
				Networks.TESTNET,
				SETTLES,
			),
		).rejects.toThrow(
			`the network did not accept transaction ${HASH} (ERROR: txInsufficientFee)`,
		);
	});

	it("never reads a polling error mentioning HostError as a refusal", async () => {
		built();
		await expect(
			submitWrite(
				network({
					lookups: [new Error("HostError: Error(Contract, #1)")],
				}),
				call,
				Networks.TESTNET,
				GIVES_UP,
			),
		).resolves.toEqual({ kind: "timeout", txHash: HASH, window: WINDOW });
	});

	it("hands on how far the history was read with an unknown outcome", async () => {
		built();
		await expect(
			submitWrite(
				network({
					lookups: [PAST_WINDOW],
					ledgers: failingFrom126,
				}),
				call,
				Networks.TESTNET,
				GIVES_UP,
			),
		).resolves.toMatchObject({
			kind: "timeout",
			txHash: HASH,
			progress: { next: 126 },
		});
	});

	it("reports an unknown outcome when lookups never answer", async () => {
		built();
		await expect(
			submitWrite(
				network({ lookups: [new TypeError("fetch failed")] }),
				call,
				Networks.TESTNET,
				GIVES_UP,
			),
		).resolves.toEqual({ kind: "timeout", txHash: HASH, window: WINDOW });
	});

	it("stays unknown when retained history starts after the validity window began", async () => {
		built();
		await expect(
			submitWrite(
				network({
					lookups: [PAST_WINDOW],
					// The RPC's history starts after ledger 121.
					ledgers: (sequence) =>
						sequence < 125
							? new Error("ledger not retained")
							: absent(sequence),
				}),
				call,
				Networks.TESTNET,
				GIVES_UP,
			),
		).resolves.toEqual({
			kind: "timeout",
			txHash: HASH,
			window: WINDOW,
			progress: { txHash: HASH, from: 121, next: 121 },
		});
	});
});

// The shared API keeps every outcome apart; `submitWrite` folds the two
// known-not-applied ones into harness failures for the checks.
describe("sendAndFollow", () => {
	it("reports a declined send as not accepted, with its status", async () => {
		await expect(
			sendAndFollow(
				network({ send: async () => ({ status: "ERROR", hash: HASH }) }),
				envelope,
				PREPARED,
				SETTLES,
			),
		).resolves.toEqual({ kind: "not-accepted", txHash: HASH, status: "ERROR" });
	});

	// A declined send keeps the code it was declined with: the same
	// transaction sent again would fail the same way, and the code says why.
	it.each([
		[
			"an insufficient fee",
			xdr.TransactionResult.fromXdr("AAAAAAAAAGT////3AAAAAA==", "base64"),
			"txInsufficientFee",
		],
		[
			"a failed operation",
			xdr.TransactionResult.fromXdr(
				"AAAAAAAAAGT/////AAAAAQAAAAAAAAAY/////wAAAAA=",
				"base64",
			),
			"txFailed (invokeHostFunctionMalformed)",
		],
		[
			"a fee bump whose transaction is out of sequence",
			{
				result: {
					type: "txFeeBumpInnerFailed",
					innerResultPair: { result: { result: { type: "txBadSeq" } } },
				},
			},
			"txFeeBumpInnerFailed (txBadSeq)",
		],
	])(
		"keeps the result code of a send declined for %s",
		async (_case, errorResult, result) => {
			await expect(
				sendAndFollow(
					network({
						send: async () => ({ status: "ERROR", hash: HASH, errorResult }),
					}),
					envelope,
					PREPARED,
					SETTLES,
				),
			).resolves.toEqual({
				kind: "not-accepted",
				txHash: HASH,
				status: "ERROR",
				result,
			});
		},
	);

	it("reports a proven expiry as expired, not as unknown", async () => {
		await expect(
			sendAndFollow(
				network({ lookups: [PAST_WINDOW] }),
				envelope,
				PREPARED,
				SETTLES,
			),
		).resolves.toEqual({ kind: "expired", txHash: HASH });
	});

	it.each([
		[
			"the preparation ledger is not a ledger",
			{ ledger: Number.POSITIVE_INFINITY, transaction: envelope },
		],
		["the preparation ledger is fractional", { ...PREPARED, ledger: 120.5 }],
	])("claims no lower bound when %s", async (_case, prepared) => {
		await expect(
			sendAndFollow(
				network({ lookups: [PAST_WINDOW] }),
				envelope,
				prepared,
				GIVES_UP,
			),
		).resolves.toEqual({
			kind: "unknown",
			txHash: HASH,
			window: { validUntil: VALID_UNTIL },
		});
	});

	it("refuses to send a transaction other than the one prepared", async () => {
		const server = network({ lookups: [SUCCESS] });
		await expect(
			sendAndFollow(server, otherEnvelope, PREPARED, SETTLES),
		).rejects.toThrow("not the one prepared; nothing was sent");
		expect(server.sendTransaction).not.toHaveBeenCalled();
	});

	// Each poll goes on with the history where the one before stopped.
	it("goes on with the history from one poll to the next", async () => {
		// The page at 126 fails once, its one-ledger retry too, then answers.
		let failures = 2;
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) =>
				sequence === 126 && failures-- > 0
					? new Error("fetch failed")
					: absent(sequence),
		});
		await expect(
			sendAndFollow(server, envelope, PREPARED, SETTLES),
		).resolves.toEqual({ kind: "expired", txHash: HASH });
		expect(starts(server)).toEqual([121, 126, 126, 126, 131, 136]);
	});

	it("reports how far the history was read when it gives up", async () => {
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: failingFrom126,
		});
		await expect(
			sendAndFollow(server, envelope, PREPARED, GIVES_UP),
		).resolves.toEqual({
			kind: "unknown",
			txHash: HASH,
			window: WINDOW,
			progress: { txHash: HASH, from: 121, next: 126 },
		});
	});

	// A system clock moved back must not buy the follow more time.
	// Real timers: the wall clock jumps an hour back 50ms in, and only a
	// deadline kept on a monotonic clock still ends on time.
	it("stops following at its limit when the system clock moves back", async () => {
		const wall = Date.now.bind(Date);
		const started = performance.now();
		vi.spyOn(Date, "now").mockImplementation(() =>
			performance.now() - started > 50 ? wall() - 60 * 60_000 : wall(),
		);
		await expect(
			sendAndFollow(
				network({ lookups: [new TypeError("fetch failed")] }),
				envelope,
				PREPARED,
				{ pollIntervalMs: 10, giveUpAfterMs: 200 },
			),
		).resolves.toMatchObject({ kind: "unknown" });
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	// The deadline comes from the signed envelope, which a signer controls,
	// and a lookup can hang for the whole RPC timeout. Neither stretches the
	// follow past its four-minute limit.
	it("stops following at its limit, whatever the envelope or the lookups do", async () => {
		vi.useFakeTimers();
		try {
			const forever = {
				hash: () => SIGNED,
				timeBounds: { minTime: "0", maxTime: "99999999999" },
			} as unknown as Transaction;
			const hanging = {
				serverURL: new URL("https://rpc.example.invalid"),
				sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: HASH })),
				getTransaction: vi.fn(() => new Promise(() => {})),
			} as unknown as rpc.Server;
			let settled = false;
			const following = sendAndFollow(hanging, forever, {
				ledger: 120,
				transaction: forever,
			}).then((outcome) => {
				settled = true;
				return outcome;
			});
			await vi.advanceTimersByTimeAsync(4 * 60_000 - 1_000);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(settled).toBe(true);
			await expect(following).resolves.toMatchObject({ kind: "unknown" });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("lookupOutcome", () => {
	// Two servers behind one URL can each read the hash before ingesting
	// ledger 122, where it landed, then report a range past the deadline.
	// Both lookups by hash say NOT_FOUND; the ledger's own results have it.
	it("finds a transaction both lookups missed, in its ledger's own results", async () => {
		const server = network({
			lookups: [PAST_WINDOW, PAST_WINDOW],
			ledgers: (sequence) =>
				sequence === 122
					? ledger(122, VALID_UNTIL - 50, [other(1), ours()])
					: absent(sequence),
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "applied",
			ledger: 122,
		});
	});

	// A fee bump's pair carries the outer hash; the transaction this tool
	// signed is the inner one.
	it.each([
		["applied", ours("txSuccess"), "applied"],
		["failed", ours("txFailed"), "failed"],
		[
			"applied inside a fee bump",
			feeBumped("txFeeBumpInnerSuccess"),
			"applied",
		],
		["failed inside a fee bump", feeBumped("txFeeBumpInnerFailed"), "failed"],
	])(
		"reads a transaction %s from its result code",
		async (_case, pair, kind) => {
			const server = network({
				lookups: [PAST_WINDOW],
				ledgers: with124(pair),
			});
			await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
				kind,
				ledger: 124,
			});
		},
	);

	it("proves absence at the first ledger that closed after the deadline", async () => {
		const server = network({ lookups: [PAST_WINDOW] });
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "expired",
		});
		expect(server.getLedgers).toHaveBeenNthCalledWith(1, {
			startLedger: 121,
			pagination: { limit: 5 },
		});
		expect(starts(server)).toEqual([121, 126, 131, 136]);
	});

	// A ledger's own metadata says it applied nothing, so empty ledgers
	// prove absence like any others.
	it("proves absence across ledgers that applied nothing", async () => {
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) =>
				sequence < 140
					? ledger(sequence, VALID_UNTIL - 50, [])
					: absent(sequence),
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "expired",
		});
	});

	// Nothing is inferred from what the RPC leaves out: a ledger counts only
	// with its own header, close time and metadata, in sequence.
	it.each([
		["its metadata is missing", { metadataXdr: undefined }],
		["its metadata has no version", { metadataXdr: {} }],
		[
			"its metadata lists no transactions",
			{ metadataXdr: { type: "v2", v2: {} } },
		],
		["its header is missing", { headerXdr: undefined }],
		// Each of these would otherwise pass every other check, so only the
		// one named can reject it.
		["its close time is missing", decodedAs({ scpValue: {} })],
		[
			"its close time is not a whole number",
			decodedAs({ scpValue: { closeTime: "950.5" } }),
		],
		["it is another ledger than the one asked for", absent(126)],
	])(
		"proves nothing when ledger 125 comes back but %s",
		async (_case, defect) => {
			const server = network({
				lookups: [PAST_WINDOW],
				ledgers: (sequence) =>
					sequence === 125 ? { ...absent(125), ...defect } : absent(sequence),
			});
			await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toMatchObject({
				kind: "pending",
			});
		},
	);

	it.each([
		["no ledgers", { ledgers: [] }],
		["no ledgers field", {}],
		["a null ledgers field", { ledgers: null }],
	])("proves nothing from a page of %s", async (_case, page) => {
		const server = network({ lookups: [PAST_WINDOW] });
		server.getLedgers.mockResolvedValue(page);
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "pending",
			progress: { txHash: HASH, from: 121, next: 121 },
			closedAfterDeadline: 200,
		});
	});

	it.each([
		["the history read fails", () => new Error("fetch failed")],
		[
			"the history starts after the first ledger that could hold it",
			(sequence: number) => absent(sequence + 1),
		],
	])("stays pending when %s", async (_case, ledgers) => {
		const server = network({ lookups: [PAST_WINDOW], ledgers });
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "pending",
			progress: { txHash: HASH, from: 121, next: 121 },
			closedAfterDeadline: 200,
		});
	});

	// Whether it applied stays open; that it can no longer apply does not.
	// The walk reads on for a receipt, up to the first ledger past the
	// deadline, which then proves nothing.
	it("stays pending when a result inside the window cannot identify an inner transaction", async () => {
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: with124(other(2, "txBadSeq")),
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "pending",
			progress: { txHash: HASH, from: 121, next: 140, unidentified: true },
			closedAfterDeadline: 200,
		});
	});

	// A transaction lands once, so an unidentified result before its
	// receipt is someone else's.
	it("reads a receipt in a ledger after one with an unidentified result", async () => {
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) =>
				sequence === 122
					? ledger(122, VALID_UNTIL - 50, [other(2, "txBadSeq")])
					: sequence === 123
						? ledger(123, VALID_UNTIL - 50, [ours()])
						: absent(sequence),
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "applied",
			ledger: 123,
		});
	});

	// Its own hash names a transaction whatever code failed it; only a fee
	// bump's inner hash goes unread under the other codes.
	it("settles a transaction that failed under another code by its own hash", async () => {
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: with124(
				ledgerResult(HASH, xdr.TransactionResultResult.txBadSeq()),
			),
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "failed",
			ledger: 124,
		});
	});

	// The unidentified result travels with the progress, so a later lookup
	// that reads only clear ledgers still cannot prove absence.
	it("proves no absence across an unidentified result an earlier lookup read", async () => {
		const first = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) =>
				sequence >= 126
					? new Error("fetch failed")
					: sequence === 122
						? ledger(122, VALID_UNTIL - 50, [other(2, "txBadSeq")])
						: absent(sequence),
		});
		const stopped = await lookupOutcome(first, HASH, WINDOW);
		expect(stopped).toMatchObject({
			progress: { txHash: HASH, from: 121, next: 126, unidentified: true },
		});
		const second = network({ lookups: [PAST_WINDOW] });
		await expect(
			lookupOutcome(
				second,
				HASH,
				WINDOW,
				undefined,
				stopped.kind === "pending" ? stopped.progress : undefined,
			),
		).resolves.toEqual({
			kind: "pending",
			progress: { txHash: HASH, from: 121, next: 140, unidentified: true },
			closedAfterDeadline: 200,
		});
		expect(starts(second)[0]).toBe(126);
	});

	// A verified result set that holds the receipt settles the outcome; an
	// apply-time error beside it, such as txBadSeq, cannot be the receipt
	// too, since a transaction lands once.
	it("reads a receipt in a ledger that also applied an unidentified result", async () => {
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) =>
				sequence === 124
					? ledger(124, VALID_UNTIL - 50, [other(2, "txBadSeq"), ours()])
					: absent(sequence),
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "applied",
			ledger: 124,
		});
	});

	// The last case's results hash the same as ledger 124's own, so only the
	// header embedded in the metadata shows whose metadata it is.
	it.each([
		"another ledger's metadata",
		"an incomplete result set",
		"another ledger's metadata with the same results",
	] as const)(
		"does not accept %s as proof that a transaction expired",
		async (defect) => {
			const original = ledger(124, VALID_UNTIL - 50, [ours()]);
			const metadataXdr =
				defect === "another ledger's metadata"
					? absent(125).metadataXdr
					: defect === "another ledger's metadata with the same results"
						? ledger(130, VALID_UNTIL - 50, [ours()]).metadataXdr
						: {
								...original.metadataXdr,
								v2: { ...original.metadataXdr.v2, txProcessing: [] },
							};
			const server = network({
				lookups: [PAST_WINDOW],
				ledgers: (sequence) =>
					sequence === 124 ? { ...original, metadataXdr } : absent(sequence),
			});
			await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
				kind: "pending",
				progress: { txHash: HASH, from: 121, next: 124 },
				closedAfterDeadline: 200,
			});
		},
	);

	// A ledger that closed after the deadline cannot hold the transaction,
	// so what it applied needs no identity to end the proof.
	it("needs no identity in a ledger that closed after the deadline", async () => {
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) =>
				sequence === 140
					? ledger(140, VALID_UNTIL + 5, [other(2, "txBadSeq")])
					: absent(sequence),
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "expired",
		});
	});

	// Hashes are matched as the SDK renders them. Rendered any other way than
	// hex, none could ever match, and every ledger would look clear of it.
	// Only the rendering of the transaction's own hash changes: its bytes,
	// the result set and the header that commits to it are as the ledger
	// has them, so only the comparison of hashes is under test. A hash that
	// cannot be compared could be the transaction's, so no expiry is proven.
	it("proves no absence across a result whose hash the SDK does not render as hex", async () => {
		const pair = ours();
		const hidden = Object.assign(Object.create(pair), {
			transactionHash: Object.assign(Object.create(pair.transactionHash), {
				toString: () => "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=",
			}),
		}) as xdr.TransactionResultPair;
		const real = ledger(124, VALID_UNTIL - 50, [pair]);
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) =>
				sequence === 124
					? {
							...real,
							metadataXdr: {
								...real.metadataXdr,
								v2: {
									...real.metadataXdr.v2,
									txProcessing: [{ result: hidden }],
								},
							},
						}
					: absent(sequence),
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "pending",
			progress: { txHash: HASH, from: 121, next: 140, unidentified: true },
			closedAfterDeadline: 200,
		});
	});

	// Contradictory history proves nothing, in either direction.
	it("stays pending when the receipt is in a ledger that closed after the deadline", async () => {
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) =>
				sequence === 140
					? ledger(140, VALID_UNTIL + 5, [ours()])
					: absent(sequence),
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toMatchObject({
			kind: "pending",
		});
	});

	// The decoded header decides when a ledger closed, whatever the RPC's
	// summary beside it says.
	it("reads the close time from the decoded header, not the RPC's summary", async () => {
		const summaryPast = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) => ({
				...ledger(sequence, VALID_UNTIL - 50),
				ledgerCloseTime: String(VALID_UNTIL + 5),
			}),
		});
		await expect(
			lookupOutcome(summaryPast, HASH, WINDOW),
		).resolves.toMatchObject({
			kind: "pending",
		});
		const summaryInside = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) => ({
				...ledger(sequence, VALID_UNTIL + 5),
				sequence: 7,
				ledgerCloseTime: "1",
			}),
		});
		await expect(lookupOutcome(summaryInside, HASH, WINDOW)).resolves.toEqual({
			kind: "expired",
		});
	});

	// A server's maximum page can be lower than five ledgers: it is then
	// asked for one at a time.
	it("asks for one ledger a page when the server refuses five", async () => {
		const server = network({ lookups: [PAST_WINDOW] });
		const history = network({}).getLedgers;
		server.getLedgers.mockImplementation(async (request) => {
			if ((request.pagination?.limit ?? 1) > 1) {
				throw new Error("limit must not exceed 1");
			}
			return history(request);
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "expired",
		});
		expect(server.getLedgers).toHaveBeenCalledWith({
			startLedger: 140,
			pagination: { limit: 1 },
		});
	});

	// A timer can fire a little before the clock reaches the deadline. A
	// page that ran out of time is no refusal, so what is left is not spent
	// asking for one ledger.
	it("does not ask again for one ledger when the page ran out of time", async () => {
		const real = performance.now.bind(performance);
		let lag = 0;
		const clock = vi
			.spyOn(performance, "now")
			.mockImplementation(() => real() - lag);
		try {
			const server = network({ lookups: [PAST_WINDOW] });
			server.getLedgers.mockImplementation(() => {
				lag = 5;
				return new Promise(() => {});
			});
			await expect(
				lookupOutcome(server, HASH, WINDOW, real() + 30),
			).resolves.toEqual({
				kind: "pending",
				progress: { txHash: HASH, from: 121, next: 121 },
				closedAfterDeadline: 200,
			});
			expect(server.getLedgers).toHaveBeenCalledOnce();
		} finally {
			clock.mockRestore();
		}
	});

	/** A history whose every page answers after `ms`, always inside the window. */
	function slowLedgers(server: ReturnType<typeof network>, ms: number) {
		server.getLedgers.mockImplementation(async ({ startLedger }) => {
			await new Promise((resolve) => setTimeout(resolve, ms));
			return {
				ledgers: Array.from({ length: 5 }, (_, index) =>
					ledger(startLedger + index, VALID_UNTIL - 50),
				),
			};
		});
	}

	// No request starts once the deadline has passed.
	it("makes no request for a lookup whose deadline has passed", async () => {
		const server = network({ lookups: [PAST_WINDOW] });
		await expect(
			lookupOutcome(server, HASH, WINDOW, performance.now() - 1),
		).resolves.toEqual({ kind: "pending" });
		expect(server.getTransaction).not.toHaveBeenCalled();
		expect(server.getLedgers).not.toHaveBeenCalled();
	});

	// The walk works to the lookup's deadline, not to one of its own.
	it("stops the history walk at the lookup's deadline", async () => {
		const server = network({ lookups: [PAST_WINDOW] });
		slowLedgers(server, 40);
		const started = performance.now();
		await expect(
			lookupOutcome(server, HASH, WINDOW, started + 100),
		).resolves.toMatchObject({ kind: "pending" });
		expect(performance.now() - started).toBeLessThan(400);
		const requested = server.getLedgers.mock.calls.length;
		expect(requested).toBeLessThanOrEqual(3);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(server.getLedgers).toHaveBeenCalledTimes(requested);
	});

	// Once the follow gives up, the walk starts no further request.
	it("starts no history request once the follow has given up", async () => {
		const server = network({ lookups: [PAST_WINDOW] });
		slowLedgers(server, 20);
		const started = performance.now();
		await expect(
			sendAndFollow(server, envelope, PREPARED, {
				pollIntervalMs: 0,
				giveUpAfterMs: 50,
			}),
		).resolves.toMatchObject({ kind: "unknown" });
		expect(performance.now() - started).toBeLessThan(400);
		const requested = server.getLedgers.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(server.getLedgers).toHaveBeenCalledTimes(requested);
	});

	// A timer that fires late can let an answer win the race after the
	// deadline. That answer is not accepted, receipt or not.
	it("does not accept an answer that arrives after the deadline", async () => {
		const start = performance.now();
		const clock = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(start)
			.mockReturnValue(start + 25);
		await expect(
			lookupOutcome(network({ lookups: [SUCCESS] }), HASH, WINDOW, start + 5),
		).resolves.toEqual({ kind: "pending" });
		clock.mockRestore();
	});

	// A lookup with no deadline of its own, as the page's "Check transaction
	// status" makes, still ends within a minute when the history hangs.
	it("bounds a lookup without a deadline to a minute", async () => {
		vi.useFakeTimers();
		try {
			const server = network({ lookups: [PAST_WINDOW] });
			server.getLedgers.mockImplementation(() => new Promise(() => {}));
			let settled = false;
			const looking = lookupOutcome(server, HASH, WINDOW).then((outcome) => {
				settled = true;
				return outcome;
			});
			await vi.advanceTimersByTimeAsync(59_000);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1_000);
			await expect(looking).resolves.toEqual({
				kind: "pending",
				progress: { txHash: HASH, from: 121, next: 121 },
				closedAfterDeadline: 200,
			});
			expect(server.getLedgers).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	// One lookup's work is bounded; the next goes on from where it stopped.
	it("reads at most 25 pages of history", async () => {
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: (sequence) => ledger(sequence, VALID_UNTIL - 50),
		});
		await expect(lookupOutcome(server, HASH, WINDOW)).resolves.toEqual({
			kind: "pending",
			progress: { txHash: HASH, from: 121, next: 121 + 25 * 5 },
			closedAfterDeadline: 200,
		});
		expect(server.getLedgers).toHaveBeenCalledTimes(25);
	});

	// Without the first ledger it could land in, there is nowhere to start.
	// The latest ledger still closed after the deadline: it can no longer
	// apply, whether or not it already did.
	it("reads no history without a lower bound", async () => {
		const server = network({ lookups: [PAST_WINDOW] });
		await expect(
			lookupOutcome(server, HASH, { validUntil: VALID_UNTIL }),
		).resolves.toEqual({ kind: "pending", closedAfterDeadline: 200 });
		expect(server.getLedgers).not.toHaveBeenCalled();
	});

	it("reads no history for a receipt, or while the window is open", async () => {
		for (const lookup of [SUCCESS, NOT_FOUND_YET]) {
			const server = network({ lookups: [lookup] });
			await lookupOutcome(server, HASH, WINDOW);
			expect(server.getLedgers).not.toHaveBeenCalled();
		}
	});

	it("reports a failed lookup as pending, whatever its message", async () => {
		await expect(
			lookupOutcome(
				network({ lookups: [new Error("HostError: Error(Contract, #1)")] }),
				HASH,
				WINDOW,
			),
		).resolves.toEqual({ kind: "pending" });
	});

	// Closed ledgers do not change, so a later lookup goes on from where an
	// earlier one stopped instead of reading the same ledgers again.
	it("goes on from an earlier lookup's progress", async () => {
		const first = network({ lookups: [PAST_WINDOW], ledgers: failingFrom126 });
		const stopped = await lookupOutcome(first, HASH, WINDOW);
		expect(stopped).toEqual({
			kind: "pending",
			progress: { txHash: HASH, from: 121, next: 126 },
			closedAfterDeadline: 200,
		});
		const second = network({ lookups: [PAST_WINDOW] });
		await expect(
			lookupOutcome(
				second,
				HASH,
				WINDOW,
				undefined,
				stopped.kind === "pending" ? stopped.progress : undefined,
			),
		).resolves.toEqual({ kind: "expired" });
		expect(starts(second)).toEqual([126, 131, 136]);
	});

	it.each([
		[
			"another transaction's",
			{ txHash: "cd".repeat(32), from: 121, next: 126 },
		],
		["from another window", { txHash: HASH, from: 100, next: 126 }],
		[
			"behind the window's first ledger",
			{ txHash: HASH, from: 121, next: 100 },
		],
		["not at a ledger", { txHash: HASH, from: 121, next: 126.5 }],
	])("starts over when the progress is %s", async (_case, progress) => {
		const server = network({ lookups: [PAST_WINDOW] });
		await expect(
			lookupOutcome(server, HASH, WINDOW, undefined, progress),
		).resolves.toEqual({ kind: "expired" });
		expect(starts(server)[0]).toBe(121);
	});

	it("keeps the progress it was given when the history read fails", async () => {
		const progress = { txHash: HASH, from: 121, next: 126 };
		const server = network({
			lookups: [PAST_WINDOW],
			ledgers: () => new Error("fetch failed"),
		});
		await expect(
			lookupOutcome(server, HASH, WINDOW, undefined, progress),
		).resolves.toEqual({ kind: "pending", progress, closedAfterDeadline: 200 });
	});

	// A walk is only started past the deadline, so one under way goes on
	// when the lookup by hash fails, or comes from a server still inside the
	// window. Only a lookup that saw the deadline pass names the ledger.
	it.each([
		["fails", new TypeError("fetch failed")],
		["comes from a server still inside the window", NOT_FOUND_YET],
	])(
		"goes on with a walk under way when the lookup by hash %s",
		async (_case, lookup) => {
			const progress = { txHash: HASH, from: 121, next: 126 };
			const settles = network({
				lookups: [lookup],
				ledgers: (sequence) =>
					sequence === 126
						? ledger(126, VALID_UNTIL - 50, [ours()])
						: absent(sequence),
			});
			await expect(
				lookupOutcome(settles, HASH, WINDOW, undefined, progress),
			).resolves.toEqual({ kind: "applied", ledger: 126 });
			expect(starts(settles)[0]).toBe(126);
			const stalls = network({
				lookups: [lookup],
				ledgers: () => new Error("fetch failed"),
			});
			await expect(
				lookupOutcome(stalls, HASH, WINDOW, undefined, progress),
			).resolves.toEqual({ kind: "pending", progress });
		},
	);

	// The walk began even though its first page failed, so the next lookup
	// goes on with it when the lookup by hash fails, and finds the receipt.
	it("goes on with a walk whose first page failed when the lookup by hash then fails", async () => {
		const first = network({
			lookups: [PAST_WINDOW],
			ledgers: () => new Error("fetch failed"),
		});
		const stopped = await lookupOutcome(first, HASH, WINDOW);
		expect(stopped).toMatchObject({
			kind: "pending",
			progress: { txHash: HASH, from: 121, next: 121 },
		});
		const second = network({
			lookups: [new Error("503 Service Unavailable")],
			ledgers: (sequence) =>
				sequence === 121
					? ledger(121, VALID_UNTIL - 50, [ours()])
					: absent(sequence),
		});
		await expect(
			lookupOutcome(
				second,
				HASH,
				WINDOW,
				undefined,
				stopped.kind === "pending" ? stopped.progress : undefined,
			),
		).resolves.toEqual({ kind: "applied", ledger: 121 });
	});

	// Without a walk of its own under way, nothing says the deadline passed.
	it("starts no walk on another transaction's progress when the lookup fails", async () => {
		const server = network({ lookups: [new TypeError("fetch failed")] });
		const progress = { txHash: "cd".repeat(32), from: 121, next: 126 };
		await expect(
			lookupOutcome(server, HASH, WINDOW, undefined, progress),
		).resolves.toEqual({ kind: "pending", progress });
		expect(server.getLedgers).not.toHaveBeenCalled();
	});

	it("proves nothing without a window", async () => {
		await expect(
			lookupOutcome(network({ lookups: [PAST_WINDOW] }), HASH, undefined),
		).resolves.toEqual({ kind: "pending" });
	});
});

/**
 * Every value the precondition reads must be in the RPC's documented form:
 * ledgers are positive integers, close times too, sent as decimal strings.
 * Anything else must not even start the history scan.
 */
describe("mayHaveExpired", () => {
	const seen = (fields: Partial<Seen>) =>
		({
			...PAST_WINDOW,
			...fields,
		}) as unknown as rpc.Api.GetTransactionResponse;

	it("holds once the latest ledger closed after the deadline", () => {
		expect(mayHaveExpired(seen({}), WINDOW)).toBe(true);
	});

	it.each([
		["missing", undefined],
		["null", null],
		["empty", ""],
		["not a number", "soon"],
		["fractional", "1000.5"],
		["hex", "0x400"],
		["in exponent form", "1e4"],
		["infinite", Number.POSITIVE_INFINITY],
		["negative", "-5"],
		["at the deadline, not past it", String(VALID_UNTIL)],
	])("fails when the latest close time is %s", (_case, value) => {
		expect(mayHaveExpired(seen({ latestLedgerCloseTime: value }), WINDOW)).toBe(
			false,
		);
	});

	it.each([
		["missing", undefined],
		["not a number", "200"],
		["infinite", Number.POSITIVE_INFINITY],
	])("fails when the latest ledger is %s", (_case, value) => {
		expect(mayHaveExpired(seen({ latestLedger: value }), WINDOW)).toBe(false);
	});

	it.each([
		["zero", 0],
		["fractional", 1000.5],
		["not a number", Number.NaN],
	])("fails when the deadline is %s", (_case, value) => {
		expect(mayHaveExpired(seen({}), { ...WINDOW, validUntil: value })).toBe(
			false,
		);
	});

	// How far back the history reaches is for the history's own answer to
	// show: a lookup by hash from a server with less of it still starts the
	// scan, which checks its first page.
	it("leaves retention to the history", () => {
		expect(mayHaveExpired(seen({ oldestLedger: 125 }), WINDOW)).toBe(true);
	});

	it("fails for anything but NOT_FOUND", () => {
		expect(mayHaveExpired(seen({ status: "SUCCESS" }), WINDOW)).toBe(false);
	});
});

describe("simulateRead, for a ledger the caller needs", () => {
	const source = new Account(Keypair.random().publicKey(), "1");
	const read = { contractId: call.contractId, method: "balance", args: [] };
	/** A server whose simulations answer from each ledger in turn, then the last. */
	function answering(...ledgers: number[]) {
		let asked = 0;
		return {
			simulateTransaction: vi.fn(async () => ({
				latestLedger: ledgers[Math.min(asked++, ledgers.length - 1)],
			})),
		} as unknown as rpc.Server & {
			simulateTransaction: ReturnType<typeof vi.fn>;
		};
	}

	it("asks again until the answer is from that ledger", async () => {
		const server = answering(129, 129, 130);
		await expect(
			simulateRead(
				server,
				source,
				{ ...read, minLedger: 130 },
				Networks.TESTNET,
				{
					pollIntervalMs: 0,
				},
			),
		).resolves.toMatchObject({ latestLedger: 130 });
		expect(server.simulateTransaction).toHaveBeenCalledTimes(3);
	});

	// A request that fails says nothing about the ledger the server has
	// reached, so while time is left it is asked again.
	it("asks again after a request that fails while time is left", async () => {
		const server = answering(130);
		server.simulateTransaction
			.mockResolvedValueOnce({ latestLedger: 129 })
			.mockRejectedValueOnce(new Error("fetch failed"));
		await expect(
			simulateRead(
				server,
				source,
				{ ...read, minLedger: 130 },
				Networks.TESTNET,
				{ pollIntervalMs: 0 },
			),
		).resolves.toMatchObject({ latestLedger: 130 });
		expect(server.simulateTransaction).toHaveBeenCalledTimes(3);
	});

	it("asks once with no ledger to reach", async () => {
		const server = answering(5);
		await simulateRead(server, source, read, Networks.TESTNET);
		expect(server.simulateTransaction).toHaveBeenCalledOnce();
	});

	// Waiting is bounded: a server that never catches up leaves the caller
	// the answer it has, to refuse.
	it("gives up after 20 seconds, with the answer it has", async () => {
		vi.useFakeTimers();
		try {
			const server = answering(129);
			let settled = false;
			const reading = simulateRead(
				server,
				source,
				{ ...read, minLedger: 130 },
				Networks.TESTNET,
			).then((answer) => {
				settled = true;
				return answer;
			});
			await vi.advanceTimersByTimeAsync(19_000);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1_000);
			await expect(reading).resolves.toMatchObject({ latestLedger: 129 });
		} finally {
			vi.useRealTimers();
		}
	});
});

// A request that hangs while catching up cannot stretch the wait: it is
// bounded by what is left, and the last answer stands.
it("cuts a request it asks again off at the end of the wait", async () => {
	vi.useFakeTimers();
	try {
		let asked = 0;
		const server = {
			simulateTransaction: vi.fn(() =>
				asked++ === 0
					? Promise.resolve({ latestLedger: 129 })
					: new Promise(() => {}),
			),
		} as unknown as rpc.Server;
		let settled = false;
		const reading = simulateRead(
			server,
			new Account(Keypair.random().publicKey(), "1"),
			{
				contractId: call.contractId,
				method: "balance",
				args: [],
				minLedger: 130,
			},
			Networks.TESTNET,
		).then((answer) => {
			settled = true;
			return answer;
		});
		await vi.advanceTimersByTimeAsync(19_000);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(reading).resolves.toMatchObject({ latestLedger: 129 });
	} finally {
		vi.useRealTimers();
	}
});

describe("staleAnswer", () => {
	it.each([
		["from the ledger it needs", 130, 130],
		["from a later one", 131, 130],
		["when no ledger is needed", 5, undefined],
	])("accepts an answer %s", (_case, at, needed) => {
		expect(staleAnswer(at, needed)).toBeUndefined();
	});

	it.each([
		["before it", 129],
		["missing", undefined],
		["a string", "130"],
		["fractional", 130.5],
		["infinite", Number.POSITIVE_INFINITY],
	])("refuses an answer whose ledger is %s", (_case, at) => {
		expect(staleAnswer(at, 130)).toBe(
			`the RPC simulated this at ledger ${String(at)}, before ledger 130, whose state it had to reflect`,
		);
	});
});
