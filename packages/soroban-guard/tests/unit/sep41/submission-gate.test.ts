import { type rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, expect, it } from "vitest";
import { addressArg } from "../../../src/core/invoke.ts";
import { runSuite } from "../../../src/core/runner.ts";
import { submitApproval } from "../../../src/sep41/checks/approve.ts";
import { burnCheck } from "../../../src/sep41/checks/burn.ts";
import { sep41Suite } from "../../../src/sep41/index.ts";
import {
	guardWriteCheck,
	noteSettled,
	submitCheckWrite,
} from "../../../src/sep41/write.ts";
import {
	APPLIED,
	OWNER,
	okResponse,
	rejected,
	sequencedServer,
	settledFailure,
	signerFor,
	stubSubmit,
	writeCtx,
} from "../fixtures.ts";

const HASH = "af".repeat(32);
const WINDOW = { validUntil: 1_000, earliestLedger: 121 };

afterEach(() => {
	// The submit stub replaces a shared module export.
	stub?.mockRestore();
});
let stub: ReturnType<typeof stubSubmit> | undefined;

it("stops the real suite after an unknown write and retains the hash on later rows", async () => {
	const server: rpc.Server = sequencedServer([
		okResponse(xdr.ScVal.scvU32(7)),
		okResponse(20n),
		okResponse(0n),
		okResponse("Example"),
		okResponse("EX"),
		okResponse(0n),
		okResponse(20n),
		okResponse(0n),
		// The next write could run if the gate were missing.
		okResponse(20n),
		okResponse(0n),
	]);
	stub = stubSubmit({ kind: "timeout", txHash: HASH });
	const results = await runSuite(sep41Suite, writeCtx(server));

	expect(stub).toHaveBeenCalledTimes(1);
	expect(results.slice(0, 5).map((r) => r.status)).toEqual(
		Array(5).fill("PASS"),
	);
	expect(results[5]).toMatchObject({
		id: "sep41-transfer_from-unauthorized",
		status: "UNVERIFIABLE",
		evidence: { txHash: HASH },
	});
	for (const result of results.slice(6)) {
		expect(result).toMatchObject({
			status: "SKIPPED",
			actual: expect.stringContaining("previous transaction"),
			evidence: { txHash: HASH },
		});
	}
	expect(results).toHaveLength(16);
});

// Setup approvals go through the same door: an approval that may still
// apply changes the allowance every later check would measure.
it("closes the run to writes when a setup approval's outcome is unknown", async () => {
	const progress = { txHash: HASH, from: 121, next: 126 };
	stub = stubSubmit({
		kind: "timeout",
		txHash: HASH,
		window: WINDOW,
		progress,
		closedAfterDeadline: 200,
	});
	const ctx = writeCtx(sequencedServer([]));
	await expect(submitApproval(ctx, 1n, 100)).resolves.toMatchObject({
		kind: "timeout",
	});
	// The window travels with the hash, so the page's cleanup can later
	// prove this approval never landed instead of waiting on it forever,
	// and so does how far the history was read, for it to go on from, and
	// the ledger seen past its deadline, from which it can no longer land.
	expect(ctx.soundness.unresolvedWrite).toEqual({
		txHash: HASH,
		window: WINDOW,
		progress,
		closedAfterDeadline: 200,
	});

	const later = await guardWriteCheck(burnCheck).run(ctx);
	expect(later).toMatchObject({
		status: "SKIPPED",
		evidence: { txHash: HASH },
	});
	// Not even its premise reads ran: the stub server has no answers, and
	// the one submission was the approval.
	expect(stub).toHaveBeenCalledTimes(1);
});

it("leaves the run open after a known outcome", async () => {
	stub = stubSubmit(APPLIED);
	const ctx = writeCtx(sequencedServer([]));
	await submitApproval(ctx, 1n, 100);
	expect(ctx.soundness.unresolvedWrite).toBeUndefined();
});

// The guard stops a check before it starts, so reaching the door with the
// run closed is a bug in this tool. It must not pass the earlier hash off
// as this call's, and must not send anything.
it("refuses a submission once the run is closed, without sending it", async () => {
	stub = stubSubmit(APPLIED);
	const ctx = writeCtx(sequencedServer([]));
	ctx.soundness.unresolvedWrite = { txHash: HASH };
	const signer = ctx.parties.owner.signer;
	if (signer === undefined) throw new Error("fixture has an owner signer");
	await expect(
		submitCheckWrite(ctx, {
			method: "transfer",
			args: [addressArg(ctx.parties.owner.address)],
			signer,
		}),
	).rejects.toThrow(/internal: write submitted after transaction/);
	expect(stub).not.toHaveBeenCalled();
});

// Every write after one that settled is simulated, and read around, at the
// ledger it settled in or later.
it("holds the writes after a settled one to the ledger it settled in", async () => {
	stub = stubSubmit(APPLIED);
	const ctx = writeCtx(sequencedServer([]));
	await submitApproval(ctx, 1n, 100);
	expect(stub.mock.calls[0]?.[1]).not.toHaveProperty("minLedger");
	expect(ctx.soundness.settledThrough).toBe(APPLIED.ledger);
	await submitApproval(ctx, 1n, 100);
	expect(stub.mock.calls[1]?.[1]).toMatchObject({ minLedger: APPLIED.ledger });
});

// A transaction that failed on the ledger was still applied: it charged
// its fee and used its sequence number.
it("counts a write that failed on the ledger", async () => {
	stub = stubSubmit(settledFailure("tx_failed", "abc123", 200));
	const ctx = writeCtx(sequencedServer([]));
	await submitApproval(ctx, 1n, 100);
	expect(ctx.soundness.settledThrough).toBe(200);
});

it("moves nothing for a refusal at simulation, which never reached a ledger", async () => {
	stub = stubSubmit(rejected("HostError: Error(Contract, #4)"));
	const ctx = writeCtx(sequencedServer([]));
	await submitApproval(ctx, 1n, 100);
	expect(ctx.soundness.settledThrough).toBeUndefined();
});

it.each([
	["the run's", 300, 200, 300],
	["the call's own", 100, 200, 200],
])(
	"simulates a write at %s ledger, whichever is later",
	async (_case, settled, own, expected) => {
		stub = stubSubmit(APPLIED);
		const ctx = writeCtx(sequencedServer([]));
		ctx.soundness.settledThrough = settled;
		await submitCheckWrite(ctx, {
			method: "approve",
			args: [],
			signer: signerFor(OWNER),
			minLedger: own,
		});
		expect(stub.mock.calls[0]?.[1]).toMatchObject({ minLedger: expected });
	},
);

it.each([
	["an older ledger", 100],
	["a ledger that is not one", 250.5],
	["no ledger", undefined],
])("keeps the run's ledger for %s", (_case, ledger) => {
	const soundness = { settledThrough: 200 };
	noteSettled(soundness, ledger);
	expect(soundness.settledThrough).toBe(200);
});
