import { Account, rpc, xdr } from "@stellar/stellar-sdk";
import type { Sep41Context } from "soroban-guard/src/sep41/context.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ledgerResult,
	ledgerWithResults,
} from "../../soroban-guard/tests/fixtures/ledger.ts";

/**
 * The end of a browser run: sending the temporary account's units back,
 * and what the run reports when that account could not be set up. These
 * paths move the visitor's units or decide which verdicts survive, and a
 * healthy testnet never exercises them — so the network and the suite are
 * stubbed and `runChecks` is driven whole.
 */
vi.mock("soroban-guard/src/core/funding.ts", () => ({
	fundAccountInLedger: vi.fn(),
}));
vi.mock("soroban-guard/src/core/spec.ts", () => ({
	inspectContract: vi.fn(async () => ({ kind: "wasm", functions: [] })),
}));
vi.mock("soroban-guard/src/core/runner.ts", () => ({
	runSuite: vi.fn(async () => []),
}));
vi.mock("soroban-guard/src/sep41/index.ts", () => ({
	sep41Suite: { checks: [] },
	withCoverageGaps: (results: unknown) => results,
}));
vi.mock("soroban-guard/src/core/invoke.ts", async (importActual) => ({
	...(await importActual<typeof import("soroban-guard/src/core/invoke.ts")>()),
	simulateRead: vi.fn(async () => ({})),
	interpretSimulation: vi.fn(),
	submitWrite: vi.fn(),
}));

const { fundAccountInLedger } = await import(
	"soroban-guard/src/core/funding.ts"
);
const { interpretSimulation, simulateRead, submitWrite } = await import(
	"soroban-guard/src/core/invoke.ts"
);
const { runSuite } = await import("soroban-guard/src/core/runner.ts");
const { inspectContract } = await import("soroban-guard/src/core/spec.ts");
const { claimDemoTokens, transactionStatus, runChecks, tokenBalance } =
	await import("../src/scripts/run.ts");
const { mayStillLand } = await import("../src/scripts/owed.ts");
const { DEMO_CONTRACT } = await import("../src/data/demo.ts");

const OWNER = "GAFD36WZNOJ4NBHB25QL6XRU2OYNIQC3IEUAXPIQ7FVDYLJE5H5ZVQ5G";
const REQUEST = {
	contractId: "CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54",
	rpcUrl: "https://example.invalid",
	networkPassphrase: "Test SDF Network ; September 2015",
	ownerAddress: OWNER,
	// Never called: the suite is stubbed. Present so no wallet is asked.
	ownerSigner: {} as never,
};

const balance = (value: bigint) =>
	({ kind: "ok", value, type: "scvI128" }) as const;
const applied = { kind: "applied", txHash: "h", ledger: 1 } as const;
const rejected = {
	kind: "rejected",
	diagnostics: "tx_failed",
	settled: true,
} as const;

beforeEach(() => {
	vi.mocked(fundAccountInLedger).mockReset().mockResolvedValue(undefined);
	vi.mocked(interpretSimulation).mockReset();
	// Answers from a ledger past every one these tests settle in.
	vi.mocked(simulateRead)
		.mockReset()
		.mockResolvedValue({ latestLedger: 10_000 } as never);
	vi.mocked(submitWrite).mockReset();
	vi.mocked(runSuite).mockReset().mockResolvedValue([]);
	vi.mocked(inspectContract)
		.mockReset()
		.mockResolvedValue({ kind: "wasm", functions: [] });
	vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(
		async (address: string) => new Account(address, "1"),
	);
	vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
		sequence: 100,
	} as rpc.Api.GetLatestLedgerResponse);
	// Every ledger closed long past any window here, with none of the
	// tests' transactions in it: absence, wherever it is asked.
	vi.spyOn(rpc.Server.prototype, "getLedgers").mockImplementation(history([]));
});

/** A close time long past any window in these tests. */
const FAR = Math.floor(Date.now() / 1000) + 86_400;

/** A close time inside the windows here, which close at t=1000. */
const INSIDE = 900;

/**
 * A ledger history as `getLedgers` answers it: each ledger with its decoded
 * header and the results its metadata lists. Ledgers up to the last one
 * holding one of `transactions` closed inside the window, every later one
 * long past it. History reaches back to ledger `oldestLedger`.
 */
function history(
	transactions: { txHash: string; status: string; ledger: number }[],
	oldestLedger = 1,
) {
	const lastHolding = Math.max(0, ...transactions.map((tx) => tx.ledger));
	return async (request: unknown) => {
		const { startLedger, pagination } = request as {
			startLedger: number;
			pagination?: { limit?: number };
		};
		if (startLedger < oldestLedger) {
			throw new Error("ledger not retained");
		}
		return {
			ledgers: Array.from({ length: pagination?.limit ?? 5 }, (_, index) => {
				const sequence = startLedger + index;
				const results = transactions
					.filter((tx) => tx.ledger === sequence)
					.map((tx) =>
						ledgerResult(
							tx.txHash,
							tx.status === "SUCCESS"
								? xdr.TransactionResultResult.txSuccess([])
								: tx.status === "FAILED"
									? xdr.TransactionResultResult.txFailed([])
									: xdr.TransactionResultResult.txBadSeq(),
						),
					);
				return ledgerWithResults(
					sequence,
					sequence <= lastHolding ? INSIDE : FAR,
					results,
				);
			}),
		} as unknown as rpc.Api.GetLedgersResponse;
	};
}

afterEach(() => vi.restoreAllMocks());

function receipt(status: rpc.Api.GetTransactionStatus) {
	return { status } as rpc.Api.GetTransactionResponse;
}

/** A transaction valid until t=1000 that no ledger before 121 could include. */
const WINDOW = { validUntil: 1_000, earliestLedger: 121 };

/** "Not found", from an RPC whose latest ledger closed at `closeTime`. */
function notFound(closeTime: number): rpc.Api.GetMissingTransactionResponse {
	return {
		status: rpc.Api.GetTransactionStatus.NOT_FOUND,
		txHash: "",
		latestLedger: 200,
		latestLedgerCloseTime: closeTime,
		oldestLedger: 1,
		oldestLedgerCloseTime: 1,
	};
}

function pendingCleanup(
	cleanup: Awaited<ReturnType<typeof runChecks>>["cleanup"],
	hash: string,
) {
	expect(cleanup).toMatchObject({ pendingTxHash: hash });
	if (!cleanup || !("failed" in cleanup) || !cleanup.retry) {
		throw new Error("expected cleanup waiting for a receipt");
	}
	return cleanup.retry;
}

describe("runChecks cleanup", () => {
	it("does not attempt cleanup while an earlier write is unresolved", async () => {
		const hash = "ab".repeat(32);
		vi.mocked(runSuite).mockImplementationOnce(async (_suite, ctx) => {
			(ctx as Sep41Context).soundness.unresolvedWrite = { txHash: hash };
			return [];
		});
		vi.spyOn(rpc.Server.prototype, "getTransaction")
			.mockResolvedValueOnce(receipt(rpc.Api.GetTransactionStatus.NOT_FOUND))
			.mockResolvedValueOnce(receipt(rpc.Api.GetTransactionStatus.SUCCESS));
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue(applied);

		const { cleanup } = await runChecks(REQUEST);
		const waiting = await pendingCleanup(cleanup, hash)();
		expect(submitWrite).not.toHaveBeenCalled();
		await expect(pendingCleanup(waiting, hash)()).resolves.toEqual({
			returned: 5n,
			settledThrough: 1,
		});
		expect(submitWrite).toHaveBeenCalledOnce();
	});

	it("reconciles a cleanup that applied after its response was lost", async () => {
		const hash = "cd".repeat(32);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue({ kind: "timeout", txHash: hash });
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			receipt(rpc.Api.GetTransactionStatus.SUCCESS),
		);
		const { cleanup } = await runChecks(REQUEST);
		await expect(pendingCleanup(cleanup, hash)()).resolves.toEqual({
			returned: 5n,
		});
		expect(submitWrite).toHaveBeenCalledOnce();
	});

	// Lookups by hash can miss a send-back that landed, as two servers
	// behind one URL can. The history has it, so the page reports the
	// return and sends nothing again.
	it("reports a send-back the lookups missed but the history holds", async () => {
		const hash = "ef".repeat(32);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue({
			kind: "timeout",
			txHash: hash,
			window: WINDOW,
		});
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			notFound(WINDOW.validUntil + 5),
		);
		vi.mocked(rpc.Server.prototype.getLedgers).mockImplementation(
			history([{ txHash: hash, status: "SUCCESS", ledger: 130 }]),
		);

		const { cleanup } = await runChecks(REQUEST);

		await expect(pendingCleanup(cleanup, hash)()).resolves.toEqual({
			returned: 5n,
			settledThrough: 130,
		});
		expect(submitWrite).toHaveBeenCalledOnce();
	});

	// Each "Check transaction status" goes on with the history where the one
	// before stopped, so a long history is read once, over several clicks.
	it("goes on with the history from one status check to the next", async () => {
		const hash = "ef".repeat(32);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue({
			kind: "timeout",
			txHash: hash,
			window: WINDOW,
		});
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			notFound(WINDOW.validUntil + 5),
		);
		// Ledgers 121 to 125 read, then the page at 126 fails, its
		// one-ledger retry too; the next check reads 126, which holds it.
		const ledgers = history([{ txHash: hash, status: "SUCCESS", ledger: 126 }]);
		vi.mocked(rpc.Server.prototype.getLedgers)
			.mockImplementationOnce(ledgers)
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockImplementation(ledgers);

		const { cleanup } = await runChecks(REQUEST);
		const first = await pendingCleanup(cleanup, hash)();
		await expect(pendingCleanup(first, hash)()).resolves.toEqual({
			returned: 5n,
			settledThrough: 126,
		});
		expect(
			vi
				.mocked(rpc.Server.prototype.getLedgers)
				.mock.calls.map(
					([request]) => (request as { startLedger: number }).startLedger,
				),
		).toEqual([121, 126, 126, 126]);
		expect(submitWrite).toHaveBeenCalledOnce();
	});

	// A send-back that times out hands on how far its own follow read the
	// history, and the first status check goes on from there.
	it("goes on with the history the send-back's follow had read", async () => {
		const hash = "ef".repeat(32);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue({
			kind: "timeout",
			txHash: hash,
			window: WINDOW,
			progress: { txHash: hash, from: 121, next: 126 },
		});
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			notFound(WINDOW.validUntil + 5),
		);
		vi.mocked(rpc.Server.prototype.getLedgers).mockImplementation(
			history([{ txHash: hash, status: "SUCCESS", ledger: 126 }]),
		);

		const { cleanup } = await runChecks(REQUEST);
		await expect(pendingCleanup(cleanup, hash)()).resolves.toEqual({
			returned: 5n,
			settledThrough: 126,
		});
		expect(rpc.Server.prototype.getLedgers).toHaveBeenNthCalledWith(1, {
			startLedger: 126,
			pagination: { limit: 5 },
		});
	});

	// The suite's own unresolved write hands the cleanup how far its follow
	// read the history, and the first status check goes on from there.
	it("goes on with the history the suite's follow had read", async () => {
		const hash = "ab".repeat(32);
		vi.mocked(runSuite).mockImplementationOnce(async (_suite, ctx) => {
			(ctx as Sep41Context).soundness.unresolvedWrite = {
				txHash: hash,
				window: WINDOW,
				progress: { txHash: hash, from: 121, next: 126 },
			};
			return [];
		});
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			notFound(WINDOW.validUntil + 5),
		);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue(applied);

		const { cleanup } = await runChecks(REQUEST);
		await expect(pendingCleanup(cleanup, hash)()).resolves.toEqual({
			returned: 5n,
			settledThrough: 1,
		});
		expect(rpc.Server.prototype.getLedgers).toHaveBeenNthCalledWith(1, {
			startLedger: 126,
			pagination: { limit: 5 },
		});
	});

	// The send-back's own hash, failed on the ledger under a code other than
	// txFailed: it moved nothing, so the units are sent again, read from
	// that ledger on.
	it("sends again after the history shows the send-back failed under any code", async () => {
		const hash = "ef".repeat(32);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite)
			.mockResolvedValueOnce({ kind: "timeout", txHash: hash, window: WINDOW })
			.mockResolvedValueOnce(applied);
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			notFound(WINDOW.validUntil + 5),
		);
		vi.mocked(rpc.Server.prototype.getLedgers).mockImplementation(
			history([{ txHash: hash, status: "UNKNOWN", ledger: 130 }]),
		);

		const { cleanup } = await runChecks(REQUEST);

		await expect(pendingCleanup(cleanup, hash)()).resolves.toEqual({
			returned: 5n,
			settledThrough: 130,
		});
		expect(vi.mocked(submitWrite).mock.calls[1]?.[1]).toMatchObject({
			minLedger: 130,
		});
	});

	// The status lookup behind "Check transaction status" waits a minute at
	// most, however slowly the RPC's history answers. A send-back the click
	// then starts, once the lookup proves the first one did not apply, is
	// followed on its own.
	it("returns from a status check within a minute when the history hangs", async () => {
		const hash = "ef".repeat(32);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue({
			kind: "timeout",
			txHash: hash,
			window: WINDOW,
		});
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			notFound(WINDOW.validUntil + 5),
		);
		vi.mocked(rpc.Server.prototype.getLedgers).mockImplementation(
			() => new Promise(() => {}),
		);
		const { cleanup } = await runChecks(REQUEST);
		vi.useFakeTimers();
		try {
			let settled = false;
			const checking = pendingCleanup(cleanup, hash)().then((next) => {
				settled = true;
				return next;
			});
			// The history request has started, and is what the check waits on.
			await vi.advanceTimersByTimeAsync(59_000);
			expect(rpc.Server.prototype.getLedgers).toHaveBeenCalled();
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1_000);
			// Still waiting on the same transfer, and the key still reachable.
			pendingCleanup(await checking, hash);
			expect(submitWrite).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	// A send whose request failed may never have reached the network.
	// Waiting on its receipt alone would wait forever; once its window has
	// passed and the ledger history shows it nowhere, sending again is safe.
	it("sends the units back again once the first transfer provably never landed", async () => {
		const hash = "ef".repeat(32);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite)
			.mockResolvedValueOnce({ kind: "timeout", txHash: hash, window: WINDOW })
			.mockResolvedValueOnce(applied);
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			notFound(WINDOW.validUntil + 5),
		);

		const { cleanup } = await runChecks(REQUEST);

		await expect(pendingCleanup(cleanup, hash)()).resolves.toEqual({
			returned: 5n,
			settledThrough: 1,
		});
		const [first, second] = vi.mocked(submitWrite).mock.calls;
		expect(second?.[1].signer).toBe(first?.[1].signer);
	});

	it.each([
		["its window is still open", notFound(WINDOW.validUntil - 10), 1],
		[
			"the RPC's history no longer covers the whole window",
			notFound(WINDOW.validUntil + 5),
			125,
		],
	])(
		"keeps waiting, without sending again, while %s",
		async (_case, seen, oldest) => {
			const hash = "ef".repeat(32);
			vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
			vi.mocked(submitWrite).mockResolvedValue({
				kind: "timeout",
				txHash: hash,
				window: WINDOW,
			});
			vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(seen);
			vi.mocked(rpc.Server.prototype.getLedgers).mockImplementation(
				history([], oldest),
			);

			const { cleanup } = await runChecks(REQUEST);

			pendingCleanup(await pendingCleanup(cleanup, hash)(), hash);
			expect(submitWrite).toHaveBeenCalledOnce();
		},
	);

	// The case that separates the two questions: past the deadline, with no
	// history to say whether the transaction applied. It can no longer land,
	// so Run and the faucet may go on, reading from ledger 200; whether it
	// landed is still open, so nothing is sent again. A later check whose
	// lookup fails keeps what the earlier one saw.
	it.each([
		["a send-back the history no longer covers", "send-back", 1],
		["an earlier write the network answered DUPLICATE", "suite", 0],
	] as const)(
		"lets the page go on, sending nothing again, once %s can no longer apply",
		async (_case, sent, sends) => {
			const hash = "ef".repeat(32);
			vi.mocked(runSuite).mockImplementationOnce(async (_suite, ctx) => {
				if (sent === "suite") {
					(ctx as Sep41Context).soundness.unresolvedWrite = {
						txHash: hash,
						window: { validUntil: WINDOW.validUntil },
					};
				}
				return [];
			});
			vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
			vi.mocked(submitWrite).mockResolvedValue({
				kind: "timeout",
				txHash: hash,
				window: WINDOW,
			});
			vi.spyOn(rpc.Server.prototype, "getTransaction")
				.mockResolvedValueOnce(notFound(WINDOW.validUntil + 5))
				.mockRejectedValueOnce(new Error("fetch failed"));
			vi.mocked(rpc.Server.prototype.getLedgers).mockImplementation(
				history([], 125),
			);

			const { cleanup } = await runChecks(REQUEST);
			expect(mayStillLand(cleanup)).toBe(true);
			const checked = await pendingCleanup(cleanup, hash)();
			expect(checked).toMatchObject({
				pendingTxHash: hash,
				closedAfterDeadline: 200,
				failed: expect.stringMatching(
					/can no longer apply: ledger 200 closed after its deadline\. Whether it applied before then is not yet known\.$/,
				),
			});
			expect(mayStillLand(checked)).toBe(false);
			const again = await pendingCleanup(checked, hash)();
			expect(again).toMatchObject({ closedAfterDeadline: 200 });
			expect(mayStillLand(again)).toBe(false);
			expect(submitWrite).toHaveBeenCalledTimes(sends);
		},
	);

	// The page's floor holds the next run from its first read: the setup's
	// own transactions can only raise it.
	it.each([
		["the request's ledger", 150, 200],
		["the setup's later one", 250, 250],
	])("holds the next run's reads to %s", async (_case, funded, expected) => {
		vi.mocked(fundAccountInLedger).mockResolvedValue(funded);
		vi.mocked(interpretSimulation).mockReturnValue(balance(0n));
		await runChecks({ ...REQUEST, minLedger: 200 });
		const ctx = vi.mocked(runSuite).mock.calls[0]?.[1] as Sep41Context;
		expect(ctx.soundness.settledThrough).toBe(expected);
		expect(vi.mocked(simulateRead).mock.calls.at(-1)?.[2]).toMatchObject({
			method: "balance",
			minLedger: expected,
		});
	});

	it("resumes a paused cleanup once the earlier write provably never landed", async () => {
		const hash = "ab".repeat(32);
		vi.mocked(runSuite).mockImplementationOnce(async (_suite, ctx) => {
			(ctx as Sep41Context).soundness.unresolvedWrite = {
				txHash: hash,
				window: WINDOW,
			};
			return [];
		});
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			notFound(WINDOW.validUntil + 5),
		);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue(applied);

		const { cleanup } = await runChecks(REQUEST);

		expect(submitWrite).not.toHaveBeenCalled();
		await expect(pendingCleanup(cleanup, hash)()).resolves.toEqual({
			returned: 5n,
			settledThrough: 1,
		});
		expect(submitWrite).toHaveBeenCalledOnce();
	});

	// A trustline that may still land can change the temporary account under
	// any check naming it. The suite gets an untouched address instead, so
	// the trustline costs the spender's checks and the holder's still run.
	it.each([
		["every lookup fails", undefined],
		// Built after ledger 100, so it could be in 101, which this history
		// no longer holds: past its window proves nothing.
		["history starts after it could have landed", 102],
	])(
		"keeps an unconfirmed trustline's account out of the suite (%s)",
		async (_case, oldestLedger) => {
			vi.useFakeTimers();
			try {
				vi.mocked(inspectContract).mockResolvedValue({
					kind: "native",
					stellarAsset: true,
				});
				vi.mocked(interpretSimulation).mockReturnValue({
					kind: "ok",
					type: "scvString",
					value: `TEST:${OWNER}`,
				});
				const send = vi
					.spyOn(rpc.Server.prototype, "sendTransaction")
					.mockRejectedValue(new Error("lost response"));
				const lookup = vi.spyOn(rpc.Server.prototype, "getTransaction");
				if (oldestLedger === undefined) {
					lookup.mockRejectedValue(new Error("lookup failed"));
				} else {
					lookup.mockResolvedValue(
						notFound(Math.floor(Date.now() / 1000) + 3_600),
					);
					vi.mocked(rpc.Server.prototype.getLedgers).mockImplementation(
						history([], oldestLedger),
					);
				}

				const running = runChecks(REQUEST);
				// Followed past its 60-second window, then given up on.
				await vi.advanceTimersByTimeAsync(5 * 60_000);
				const outcome = await running;

				expect(send).toHaveBeenCalledOnce();
				const trustlineAccount = (
					send.mock.calls[0]?.[0] as { source: string } | undefined
				)?.source;
				const ctx = vi.mocked(runSuite).mock.calls[0]?.[1] as Sep41Context;
				expect(outcome.spenderSetupFailed).toMatch(
					/could not be confirmed; transaction [a-f0-9]{64} may still apply/,
				);
				expect(ctx.soundness.unresolvedWrite).toBeUndefined();
				expect(ctx.parties.spender).toMatchObject({ isThrowaway: true });
				expect(ctx.parties.spender.signer).toBeUndefined();
				expect(ctx.parties.spender.address).not.toBe(trustlineAccount);
				expect(outcome.cleanup).toBeUndefined();
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("fails setup as known when the trustline provably never landed", async () => {
		vi.mocked(inspectContract).mockResolvedValue({
			kind: "native",
			stellarAsset: true,
		});
		vi.mocked(interpretSimulation).mockReturnValue({
			kind: "ok",
			type: "scvString",
			value: `TEST:${OWNER}`,
		});
		vi.spyOn(rpc.Server.prototype, "sendTransaction").mockRejectedValue(
			new Error("lost response"),
		);
		// Ledger time well past its 60-second window, and history back to
		// the first ledger after the one read before it was built.
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			notFound(Math.floor(Date.now() / 1000) + 3_600),
		);
		vi.mocked(rpc.Server.prototype.getLedgers).mockImplementation(
			history([], 101),
		);

		const outcome = await runChecks(REQUEST);

		expect(outcome.spenderSetupFailed).toBe(
			`the temporary account's trustline to TEST expired without landing`,
		);
	});

	// A balance read from before the run's latest transaction could miss
	// units that transaction credited: the cleanup keeps the key and asks
	// again rather than reporting nothing to return.
	it("keeps the key when the balance comes from before the run's latest transaction", async () => {
		vi.mocked(runSuite).mockImplementationOnce(async (_suite, ctx) => {
			(ctx as Sep41Context).soundness.settledThrough = 500;
			return [];
		});
		vi.mocked(simulateRead).mockResolvedValueOnce({
			latestLedger: 499,
		} as never);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue(applied);

		const { cleanup } = await runChecks(REQUEST);
		expect(cleanup).toMatchObject({
			failed: expect.stringContaining("at ledger 499, before ledger 500"),
			retry: expect.any(Function),
		});
		expect(submitWrite).not.toHaveBeenCalled();
		const retry = cleanup && "retry" in cleanup ? cleanup.retry : undefined;
		await expect(retry?.()).resolves.toEqual({
			returned: 5n,
			settledThrough: 500,
		});
		expect(vi.mocked(submitWrite).mock.calls[0]?.[1]).toMatchObject({
			minLedger: 500,
		});
	});

	// The paused cleanup resumes once the earlier write settles, and its
	// balance read must not describe state from before that write.
	it("reads the balance from the ledger the earlier write settled in", async () => {
		const hash = "ab".repeat(32);
		vi.mocked(runSuite).mockImplementationOnce(async (_suite, ctx) => {
			(ctx as Sep41Context).soundness.unresolvedWrite = { txHash: hash };
			return [];
		});
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
			status: rpc.Api.GetTransactionStatus.SUCCESS,
			ledger: 777,
		} as rpc.Api.GetTransactionResponse);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue(applied);

		const { cleanup } = await runChecks(REQUEST);
		await expect(pendingCleanup(cleanup, hash)()).resolves.toEqual({
			returned: 5n,
			settledThrough: 777,
		});
		expect(vi.mocked(simulateRead).mock.calls.at(-1)?.[2]).toMatchObject({
			minLedger: 777,
		});
		expect(vi.mocked(submitWrite).mock.calls[0]?.[1]).toMatchObject({
			minLedger: 777,
		});
	});

	// The setup's own transactions count like the suite's writes.
	it("holds the suite to the ledger the temporary account's funding landed in", async () => {
		vi.mocked(fundAccountInLedger).mockResolvedValue(300);
		await runChecks(REQUEST);
		const ctx = vi.mocked(runSuite).mock.calls[0]?.[1] as Sep41Context;
		expect(ctx.soundness.settledThrough).toBe(300);
	});

	it("holds the suite to the ledger its trustline landed in", async () => {
		vi.mocked(fundAccountInLedger).mockResolvedValue(300);
		vi.mocked(inspectContract).mockResolvedValue({
			kind: "native",
			stellarAsset: true,
		});
		vi.mocked(interpretSimulation).mockReturnValue({
			kind: "ok",
			type: "scvString",
			value: `TEST:${OWNER}`,
		});
		vi.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue({
			status: "PENDING",
			hash: "",
		} as unknown as rpc.Api.SendTransactionResponse);
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
			status: rpc.Api.GetTransactionStatus.SUCCESS,
			ledger: 321,
		} as rpc.Api.GetTransactionResponse);
		await runChecks(REQUEST);
		const ctx = vi.mocked(runSuite).mock.calls[0]?.[1] as Sep41Context;
		expect(ctx.soundness.settledThrough).toBe(321);
	});

	// XLM is never sent back, so an unresolved transaction leaves nothing to
	// wait for: the page reports no cleanup due, and the results keep the
	// hash.
	it("waits on nothing for native XLM, which is not sent back", async () => {
		const hash = "ab".repeat(32);
		vi.mocked(inspectContract).mockResolvedValue({
			kind: "native",
			stellarAsset: true,
		});
		vi.mocked(interpretSimulation).mockReturnValue({
			kind: "ok",
			type: "scvString",
			value: "native",
		});
		vi.mocked(runSuite).mockImplementationOnce(async (_suite, ctx) => {
			(ctx as Sep41Context).soundness.unresolvedWrite = { txHash: hash };
			return [];
		});
		const lookup = vi.spyOn(rpc.Server.prototype, "getTransaction");

		const outcome = await runChecks(REQUEST);
		expect(outcome.cleanup).toEqual({ returned: 0n });
		expect(lookup).not.toHaveBeenCalled();
		expect(submitWrite).not.toHaveBeenCalled();
		// Nothing is sent back, but the write may still land: the page holds it.
		expect(outcome.unresolvedWrite).toEqual({ txHash: hash });
	});

	// A run with no temporary account to clean up still hands the page a
	// write that may still land; one whose cleanup waits on it does not.
	it.each([
		[
			"a named counterparty",
			{ spenderAddress: OWNER },
			{ txHash: "ab".repeat(32) },
		],
		["a cleanup waiting on it", {}, undefined],
	])(
		"hands the page an unresolved write with %s",
		async (_case, request, handed) => {
			vi.mocked(runSuite).mockImplementationOnce(async (_suite, ctx) => {
				(ctx as Sep41Context).soundness.unresolvedWrite = {
					txHash: "ab".repeat(32),
				};
				return [];
			});
			const outcome = await runChecks({ ...REQUEST, ...request });
			expect(outcome.unresolvedWrite).toEqual(handed);
		},
	);

	// The asset's name is read from the run's floor: a backend behind it
	// fails the setup instead of passing for an asset it cannot identify.
	// The trustline the identified asset needs is declined here, so the
	// setup ends at once either way, with the reason it stopped.
	it.each([
		[
			"identifies the asset from a name read at the floor",
			300,
			/trustline to TEST was refused/,
		],
		[
			"fails setup on a name read from before the floor",
			299,
			/the asset contract's name\(\) could not be read/,
		],
	])("%s", async (_case, answeredAt, setupFailed) => {
		vi.mocked(inspectContract).mockResolvedValue({
			kind: "native",
			stellarAsset: true,
		});
		vi.mocked(simulateRead).mockResolvedValue({
			latestLedger: answeredAt,
		} as never);
		vi.mocked(interpretSimulation).mockReturnValue({
			kind: "ok",
			type: "scvString",
			value: `TEST:${OWNER}`,
		});
		vi.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue({
			status: "ERROR",
			hash: "",
			errorResult: { result: { type: "txInsufficientFee" } },
		} as unknown as rpc.Api.SendTransactionResponse);
		const outcome = await runChecks({ ...REQUEST, minLedger: 300 });
		expect(vi.mocked(simulateRead).mock.calls[0]?.[2]).toMatchObject({
			method: "name",
			minLedger: 300,
		});
		expect(outcome.spenderSetupFailed).toMatch(setupFailed);
	});

	// An asset contract whose `name()` cannot be read may wrap XLM, which is
	// not sent back; an issued asset's gave the account no trustline, so it
	// holds none. The balance read here would find units all the same.
	it("sends nothing back from an asset contract whose asset could not be read", async () => {
		vi.mocked(inspectContract).mockResolvedValue({
			kind: "native",
			stellarAsset: true,
		});
		vi.mocked(interpretSimulation)
			.mockReturnValueOnce({ kind: "trapped", diagnostics: "name failed" })
			.mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue(applied);

		const { cleanup } = await runChecks(REQUEST);
		expect(cleanup).toEqual({ returned: 0n });
		expect(submitWrite).not.toHaveBeenCalled();
	});

	// WASM whose spec cannot be read is no asset contract: nothing about it
	// is read as an asset, and what the account received goes back.
	it("sends back from a WASM token whose spec cannot be read", async () => {
		vi.mocked(inspectContract).mockResolvedValue({
			kind: "native",
			stellarAsset: false,
		});
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue(applied);

		const { cleanup } = await runChecks(REQUEST);
		expect(cleanup).toEqual({ returned: 5n, settledThrough: 1 });
		expect(
			vi.mocked(simulateRead).mock.calls.map(([, , call]) => call.method),
		).not.toContain("name");
	});

	// A follow that saw the deadline pass hands that ledger on, so the first
	// cleanup already lets the page go on, while it still waits for proof
	// before sending again.
	it("starts a cleanup the page can go on from when the follow saw the deadline pass", async () => {
		const hash = "ef".repeat(32);
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue({
			kind: "timeout",
			txHash: hash,
			window: WINDOW,
			closedAfterDeadline: 200,
		});

		const { cleanup } = await runChecks(REQUEST);
		expect(cleanup).toMatchObject({
			pendingTxHash: hash,
			closedAfterDeadline: 200,
		});
		expect(mayStillLand(cleanup)).toBe(false);
		expect(submitWrite).toHaveBeenCalledOnce();
	});

	it("says why the network declined the trustline", async () => {
		vi.mocked(inspectContract).mockResolvedValue({
			kind: "native",
			stellarAsset: true,
		});
		vi.mocked(interpretSimulation).mockReturnValue({
			kind: "ok",
			type: "scvString",
			value: `TEST:${OWNER}`,
		});
		vi.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue({
			status: "ERROR",
			hash: "",
			errorResult: { result: { type: "txInsufficientFee" } },
		} as unknown as rpc.Api.SendTransactionResponse);

		const outcome = await runChecks(REQUEST);
		expect(outcome.spenderSetupFailed).toBe(
			"the temporary account's trustline to TEST was refused (ERROR: txInsufficientFee)",
		);
	});

	it("returns what the temporary account holds to the owner", async () => {
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue(applied);

		const outcome = await runChecks(REQUEST);

		expect(outcome.cleanup).toEqual({ returned: 5n, settledThrough: 1 });
		expect(submitWrite).toHaveBeenCalledOnce();
	});

	// The retry exists because the key lives nowhere else: it must sign
	// with the same temporary account, not a fresh one.
	it("keeps the key for a retry after a failed send-back", async () => {
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite)
			.mockResolvedValueOnce(rejected)
			.mockResolvedValueOnce(applied);

		const outcome = await runChecks(REQUEST);
		const cleanup = outcome.cleanup;
		if (cleanup === undefined || !("failed" in cleanup)) {
			throw new Error(`expected a failed cleanup, got ${String(cleanup)}`);
		}
		expect(cleanup.failed).toMatch(/not applied \(rejected\)/);
		expect(cleanup.retry).toBeDefined();

		expect(await cleanup.retry?.()).toEqual({
			returned: 5n,
			settledThrough: 1,
		});
		const [first, second] = vi.mocked(submitWrite).mock.calls;
		expect(second?.[1].signer).toBe(first?.[1].signer);
	});

	// An unreadable balance is not an empty one: "0 returned" would claim a
	// finished cleanup over units that may still be there.
	it("reports an unreadable balance as a failed, retryable cleanup", async () => {
		vi.mocked(interpretSimulation).mockReturnValue({
			kind: "inconclusive",
			diagnostics: "rpc timeout",
		});

		const outcome = await runChecks(REQUEST);

		expect(outcome.cleanup).toMatchObject({
			failed: expect.stringMatching(/could not be read \(rpc timeout\)/),
			retry: expect.any(Function),
		});
		expect(submitWrite).not.toHaveBeenCalled();
	});

	it("offers no retry for a negative balance", async () => {
		vi.mocked(interpretSimulation).mockReturnValue(balance(-3n));

		const outcome = await runChecks(REQUEST);

		expect(outcome.cleanup).toEqual({
			failed: "the token reports a balance of -3 for the temporary account",
		});
	});

	// Setup trouble costs the four spender-signed checks, not the run: the
	// verdicts still come back, with the reason alongside.
	it("still reports verdicts when the second account cannot be set up", async () => {
		vi.mocked(fundAccountInLedger).mockRejectedValue(
			new Error("friendbot is down"),
		);

		const outcome = await runChecks(REQUEST);

		expect(outcome.results).toEqual([]);
		expect(outcome.spenderSetupFailed).toBe("friendbot is down");
		expect(outcome.cleanup).toBeUndefined();
		expect(submitWrite).not.toHaveBeenCalled();
	});
});

// The page's own reads after a cleanup left a transaction open: the faucet
// claim, and the balance check before a run.
describe("the page's reads, held to a ledger", () => {
	it("reads a balance from the ledger it is held to", async () => {
		vi.mocked(simulateRead).mockResolvedValue({ latestLedger: 200 } as never);
		vi.mocked(interpretSimulation).mockReturnValue(balance(7n));
		await expect(
			tokenBalance({ ...REQUEST, minLedger: 200 }, OWNER),
		).resolves.toBe(7n);
		expect(vi.mocked(simulateRead).mock.calls[0]?.[2]).toMatchObject({
			method: "balance",
			minLedger: 200,
		});
	});

	it("gives no balance an RPC behind that ledger reports", async () => {
		vi.mocked(simulateRead).mockResolvedValue({ latestLedger: 199 } as never);
		vi.mocked(interpretSimulation).mockReturnValue(balance(7n));
		await expect(
			tokenBalance({ ...REQUEST, minLedger: 200 }, OWNER),
		).resolves.toBeUndefined();
	});

	it("claims at the ledger it is held to, and says where the claim landed", async () => {
		vi.mocked(submitWrite).mockResolvedValue({
			kind: "applied",
			txHash: "h",
			ledger: 321,
		});
		await expect(
			claimDemoTokens(
				{ ...REQUEST, contractId: DEMO_CONTRACT, minLedger: 200 },
				OWNER,
				{} as never,
			),
		).resolves.toEqual({ landed: 321 });
		expect(vi.mocked(submitWrite).mock.calls[0]?.[1]).toMatchObject({
			method: "faucet",
			minLedger: 200,
		});
	});

	// A claim that was sent and not confirmed may still land: the page gets
	// it back to look up, and one that failed on the ledger says where.
	it.each([
		[
			"was sent and not confirmed",
			{ kind: "timeout", txHash: "cd".repeat(32), window: WINDOW },
			{ unresolved: { txHash: "cd".repeat(32), window: WINDOW } },
		],
		[
			"was not confirmed, past a ledger closed after its deadline",
			{
				kind: "timeout",
				txHash: "cd".repeat(32),
				window: WINDOW,
				closedAfterDeadline: 200,
			},
			{
				unresolved: {
					txHash: "cd".repeat(32),
					window: WINDOW,
					closedAfterDeadline: 200,
				},
			},
		],
		[
			"failed on the ledger",
			{ ...rejected, ledger: 322 },
			{ failed: "tx_failed", ledger: 322 },
		],
	] as const)("reports a claim that %s", async (_case, sent, claim) => {
		vi.mocked(submitWrite).mockResolvedValue(sent as never);
		await expect(
			claimDemoTokens(
				{ ...REQUEST, contractId: DEMO_CONTRACT },
				OWNER,
				{} as never,
			),
		).resolves.toEqual(claim);
	});

	it.each([
		[
			"landed",
			{ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 205 },
			{ landed: 205 },
		],
		[
			"can no longer land, with no history to say whether it did",
			notFound(WINDOW.validUntil + 5),
			{
				unresolved: {
					txHash: "cd".repeat(32),
					window: WINDOW,
					// The walk began, though the history did not reach back.
					progress: { txHash: "cd".repeat(32), from: 121, next: 121 },
					closedAfterDeadline: 200,
				},
			},
		],
	])("looks a claim up again: one that %s", async (_case, seen, claim) => {
		vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
			seen as rpc.Api.GetTransactionResponse,
		);
		vi.mocked(rpc.Server.prototype.getLedgers).mockImplementation(
			history([], 125),
		);
		await expect(
			transactionStatus(REQUEST, { txHash: "cd".repeat(32), window: WINDOW }),
		).resolves.toEqual(claim);
	});
});
