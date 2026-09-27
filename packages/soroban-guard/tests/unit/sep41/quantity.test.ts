import { describe, expect, it } from "vitest";
import { readBalance } from "../../../src/sep41/checks/quantity.ts";
import { okResponse, sequencedServer, writeCtx } from "../fixtures.ts";

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
