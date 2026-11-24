import { nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	readAllowance,
	readBalance,
} from "../../../src/sep41/checks/quantity.ts";
import * as shared from "../../../src/sep41/checks/shared.ts";
import {
	collidingKeyMap,
	okResponse,
	sequencedServer,
	WRITE_LEDGER,
	writeCtx,
} from "../fixtures.ts";

describe("undecodable quantities", () => {
	afterEach(() => vi.restoreAllMocks());

	it("does not accuse the contract when decoding fails on an i128", async () => {
		vi.spyOn(shared, "callRead").mockResolvedValueOnce({
			outcome: {
				kind: "undecodable",
				type: "scvI128",
				diagnostics: "SDK decoder failed",
			},
			ledger: 1,
			fromArchive: false,
			stale: undefined,
		});
		const ctx = writeCtx(sequencedServer([]));
		const read = await readBalance(ctx, ctx.parties.owner.address);
		expect(read).toMatchObject({
			kind: "no-answer",
			detail: expect.stringContaining("SDK decoder failed"),
		});
	});

	it.each(["balance", "allowance"] as const)(
		"treats an undecodable %s map as a defect in a write's premise",
		async (method) => {
			const ctx = writeCtx(sequencedServer([okResponse(collidingKeyMap())]));
			const owner = ctx.parties.owner.address;
			const read =
				method === "balance"
					? await readBalance(ctx, owner)
					: await readAllowance(ctx, owner, ctx.parties.spender.address);
			expect(read).toMatchObject({
				kind: "defect",
				detail: expect.stringContaining("scvMap"),
				error: expect.stringContaining("more than one key"),
			});
		},
	);
});

/**
 * A u64 decodes to a bigint just as an i128 does, so a write check reading
 * its premise or after-state would accept it without the type check. Every
 * write check reads through these, so this is the one place to pin it.
 */
describe("quantities of the wrong integer type", () => {
	it.each(["balance", "allowance"] as const)(
		"treats %s returned as u64 as a defect",
		async (method) => {
			const ctx = writeCtx(
				sequencedServer([okResponse(nativeToScVal(7n, { type: "u64" }))]),
			);
			const owner = ctx.parties.owner.address;
			const read =
				method === "balance"
					? await readBalance(ctx, owner)
					: await readAllowance(ctx, owner, ctx.parties.spender.address);
			expect(read).toMatchObject({
				kind: "defect",
				detail: `${method}() returned scvU64, expected an i128`,
			});
		},
	);

	it("still accepts an i128", async () => {
		const ctx = writeCtx(
			sequencedServer([okResponse(nativeToScVal(7n, { type: "i128" }))]),
		);
		const read = await readBalance(ctx, ctx.parties.owner.address);
		expect(read).toMatchObject({ kind: "value", amount: 7n });
	});
});

/**
 * The negative-quantity rule, and the run-level memory behind it.
 *
 * A negative balance is a defect and the first check to see one FAILs it.
 * What matters here is the second read: a contract that let the holder
 * overdraw stays negative for the rest of the run, so every later check
 * meets the same wound while establishing its own premise. Repeating the
 * FAIL would report one missing bounds check as nine findings. The pin is
 * that the first is a defect and the rest are not.
 */
describe("readBalance on a negative quantity", () => {
	it("FAILs the first negative as the contract's defect", async () => {
		const ctx = writeCtx(sequencedServer([okResponse(-1n)]));
		const read = await readBalance(ctx, ctx.parties.owner.address);

		expect(read.kind).toBe("defect");
		if (read.kind === "defect") {
			expect(read.detail).toContain("balance() returned -1");
			expect(read.detail).toContain("negative");
		}
		// The run now remembers it, which is what changes the next answer.
		expect(ctx.soundness.firstNegative).toContain("balance() returned -1");
	});

	it("reports later negatives as unmeasurable, not as fresh defects", async () => {
		const ctx = writeCtx(sequencedServer([okResponse(-1n), okResponse(-500n)]));

		const first = await readBalance(ctx, ctx.parties.owner.address);
		expect(first.kind).toBe("defect");

		const second = await readBalance(ctx, ctx.parties.owner.address);
		// Not a defect: the contract is not being accused a second time for
		// the same wound. A check reading this reports UNVERIFIABLE.
		expect(second.kind).toBe("no-answer");
		if (second.kind === "no-answer") {
			// Its own value, so a reader sees the state it actually met...
			expect(second.detail).toContain("balance() returned -500");
			// ...attributed to what already went wrong, so the message says
			// why this check cannot measure rather than blaming the contract
			// twice.
			expect(second.detail).toContain("already went negative");
			expect(second.detail).toContain("first seen as");
			expect(second.detail).toContain("balance() returned -1");
		}
	});

	it("does not repeat the earlier reading when it is the same one", async () => {
		// The common case: the same holder read twice reports the same
		// number, and "-1 ... (first seen as -1)" reads as a bug in the
		// report rather than as attribution.
		const ctx = writeCtx(sequencedServer([okResponse(-1n), okResponse(-1n)]));
		await readBalance(ctx, ctx.parties.owner.address);
		const second = await readBalance(ctx, ctx.parties.owner.address);

		expect(second.kind).toBe("no-answer");
		if (second.kind === "no-answer") {
			expect(second.detail).toContain("already went negative");
			expect(second.detail).not.toContain("first seen as");
		}
	});

	it("keeps the first observation rather than overwriting it", async () => {
		const ctx = writeCtx(sequencedServer([okResponse(-1n), okResponse(-500n)]));
		await readBalance(ctx, ctx.parties.owner.address);
		await readBalance(ctx, ctx.parties.owner.address);
		// The earliest reading is the one that names the real finding; a
		// later, larger number is that finding's wake.
		expect(ctx.soundness.firstNegative).toContain("-1");
		expect(ctx.soundness.firstNegative).not.toContain("-500");
	});

	it("leaves a sound run's memory untouched", async () => {
		const ctx = writeCtx(sequencedServer([okResponse(100n)]));
		const read = await readBalance(ctx, ctx.parties.owner.address);

		expect(read.kind).toBe("value");
		// Nothing unsound observed, so nothing recorded: a later negative in
		// a different run must still read as the first.
		expect(ctx.soundness.firstNegative).toBeUndefined();
	});
});

/**
 * A read must describe state from the latest ledger a transaction of this
 * run settled in, or after. A backend behind it answers with state from
 * before that transaction, which neither a baseline nor an after-state can
 * be taken from.
 */
describe("reads behind the run's latest transaction", () => {
	afterEach(() => vi.useRealTimers());

	it("gives no answer from a ledger before it, after waiting for the RPC", async () => {
		vi.useFakeTimers();
		const behind = { ...okResponse(5n), latestLedger: WRITE_LEDGER - 1 };
		const server = {
			simulateTransaction: vi.fn(async () => behind),
		} as unknown as rpc.Server & {
			simulateTransaction: ReturnType<typeof vi.fn>;
		};
		const ctx = writeCtx(server);
		ctx.soundness.settledThrough = WRITE_LEDGER;
		const reading = readBalance(ctx, ctx.parties.owner.address);
		await vi.advanceTimersByTimeAsync(20_000);
		await expect(reading).resolves.toEqual({
			kind: "no-answer",
			detail: `the balance could not be read at a current ledger: the RPC simulated this at ledger ${WRITE_LEDGER - 1}, before ledger ${WRITE_LEDGER}, whose state it had to reflect`,
		});
		expect(server.simulateTransaction.mock.calls.length).toBeGreaterThan(1);
	});

	it("reads the answer once the RPC catches up", async () => {
		vi.useFakeTimers();
		const ctx = writeCtx(
			sequencedServer([
				{ ...okResponse(5n), latestLedger: WRITE_LEDGER - 1 },
				okResponse(7n),
			]),
		);
		ctx.soundness.settledThrough = WRITE_LEDGER;
		const reading = readBalance(ctx, ctx.parties.owner.address);
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(reading).resolves.toMatchObject({ kind: "value", amount: 7n });
	});

	it("takes any ledger before the run has settled a transaction", async () => {
		const ctx = writeCtx(
			sequencedServer([{ ...okResponse(5n), latestLedger: 1 }]),
		);
		await expect(
			readBalance(ctx, ctx.parties.owner.address),
		).resolves.toMatchObject({ kind: "value", amount: 5n });
	});
});
