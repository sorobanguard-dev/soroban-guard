import { Account, rpc } from "@stellar/stellar-sdk";
import type { Sep41Context } from "soroban-guard/src/sep41/context.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The end of a browser run: sending the temporary account's units back,
 * and what the run reports when that account could not be set up. These
 * paths move the visitor's units or decide which verdicts survive, and a
 * healthy testnet never exercises them — so the network and the suite are
 * stubbed and `runChecks` is driven whole.
 */
vi.mock("soroban-guard/src/core/funding.ts", () => ({
	fundAccount: vi.fn(),
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

const { fundAccount } = await import("soroban-guard/src/core/funding.ts");
const { interpretSimulation, submitWrite } = await import(
	"soroban-guard/src/core/invoke.ts"
);
const { runSuite } = await import("soroban-guard/src/core/runner.ts");
const { inspectContract } = await import("soroban-guard/src/core/spec.ts");
const { runChecks } = await import("../src/scripts/run.ts");

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
	vi.mocked(fundAccount).mockReset().mockResolvedValue(undefined);
	vi.mocked(interpretSimulation).mockReset();
	vi.mocked(submitWrite).mockReset();
	vi.mocked(runSuite).mockReset().mockResolvedValue([]);
	vi.mocked(inspectContract)
		.mockReset()
		.mockResolvedValue({ kind: "wasm", functions: [] });
	vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(
		async (address: string) => new Account(address, "1"),
	);
});

afterEach(() => vi.restoreAllMocks());

function receipt(status: rpc.Api.GetTransactionStatus) {
	return { status } as rpc.Api.GetTransactionResponse;
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

	it("carries an unresolved setup trustline into the suite gate", async () => {
		vi.mocked(inspectContract).mockResolvedValue({ kind: "native" });
		vi.mocked(interpretSimulation).mockReturnValue({
			kind: "ok",
			type: "scvString",
			value: `TEST:${OWNER}`,
		});
		const send = vi
			.spyOn(rpc.Server.prototype, "sendTransaction")
			.mockRejectedValue(new Error("lost response"));
		vi.spyOn(rpc.Server.prototype, "pollTransaction").mockResolvedValue(
			receipt(rpc.Api.GetTransactionStatus.NOT_FOUND),
		);

		const outcome = await runChecks(REQUEST);

		expect(send).toHaveBeenCalledOnce();
		const ctx = vi.mocked(runSuite).mock.calls[0]?.[1] as Sep41Context;
		const hash = ctx.soundness.unresolvedWrite?.txHash;
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		expect(outcome.spenderSetupFailed).toContain(hash);
		expect(submitWrite).not.toHaveBeenCalled();
	});

	it("returns what the temporary account holds to the owner", async () => {
		vi.mocked(interpretSimulation).mockReturnValue(balance(5n));
		vi.mocked(submitWrite).mockResolvedValue(applied);

		const outcome = await runChecks(REQUEST);

		expect(outcome.cleanup).toEqual({ returned: 5n });
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

		expect(await cleanup.retry?.()).toEqual({ returned: 5n });
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
		vi.mocked(fundAccount).mockRejectedValue(new Error("friendbot is down"));

		const outcome = await runChecks(REQUEST);

		expect(outcome.results).toEqual([]);
		expect(outcome.spenderSetupFailed).toBe("friendbot is down");
		expect(outcome.cleanup).toBeUndefined();
		expect(submitWrite).not.toHaveBeenCalled();
	});
});
