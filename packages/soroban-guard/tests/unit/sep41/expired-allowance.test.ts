import { afterEach, describe, expect, it, vi } from "vitest";
import * as invoke from "../../../src/core/invoke.ts";
import { expiredAllowanceCheck } from "../../../src/sep41/checks/expired-allowance.ts";
import type { Sep41Context } from "../../../src/sep41/context.ts";
import {
	APPLIED,
	errorResponse,
	okResponse,
	rejected,
	sequencedServer,
	settledFailure,
	stubSubmit,
	writeCtx,
} from "../fixtures.ts";

/**
 * Offline coverage for the expired-allowance refusal.
 *
 * The only check that creates the condition it tests rather than reading
 * one: `allowance()` returns the amount alone and never the ledger it dies
 * at, so an expired grant is indistinguishable from a live one until it is
 * spent. It approves a short-lived grant, waits for the ledger to pass it,
 * then spends — and a refusal is the PASS.
 *
 * These stub `getLatestLedger` so the wait resolves immediately. The
 * production path polls a live network; what is pinned here is the verdict
 * mapping and the bounded give-up, not the sleeping.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * A context whose ledger advances past the grant on the second look, which
 * is what the wait is waiting for. `stall` never advances, so the bounded
 * wait gives up.
 */
function ctxWithLedger(
	server: ReturnType<typeof sequencedServer>,
	{ stall = false } = {},
): Sep41Context {
	const ctx = writeCtx(server);
	let calls = 0;
	const ledgerServer = Object.assign(ctx.server, {
		getLatestLedger: async () => {
			calls += 1;
			// First call sets the baseline; later ones are the wait polling.
			return { sequence: stall ? 100 : calls === 1 ? 100 : 200 };
		},
	});
	return { ...ctx, server: ledgerServer };
}

/**
 * Reads before the submit, in order: holder and recipient as premises, the
 * allowance read back to confirm the setup approval actually created a
 * grant, then the post-wait re-reads of holder and recipient, and finally
 * the post-wait allowance.
 *
 * The confirmation read is third rather than appended because it happens
 * immediately after the approval and before the wait — a contract that
 * accepts `approve` and stores nothing must be caught before this check
 * spends ten seconds testing an allowance that never existed.
 */
const PREMISE = [
	okResponse(100n),
	okResponse(5n),
	okResponse(1n),
	okResponse(100n),
	okResponse(5n),
	okResponse(1n),
];

describe("expiredAllowanceCheck", () => {
	// The whole point: the grant lapsed, so refusing is correct.
	it("PASSes when the contract refuses a spend on a lapsed grant", async () => {
		vi.spyOn(invoke, "submitWrite")
			// The setup approval lands, then the spend is refused.
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(rejected("HostError: Error(Contract, #4)"));
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(sequencedServer(PREMISE)),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("expired at ledger 102");
		expect(result.actual).toContain("refused");
		// The evidence names the grant that was confirmed before the wait:
		// without it, the post-wait allowance alone cannot tell an expired
		// grant from one that never landed.
		expect(result.evidence.before?.granted).toBe("1");
	});

	// The false PASS this check is most exposed to. A contract that accepts
	// `approve` and stores nothing leaves no grant to expire: the spend is
	// then refused for having no allowance at all, and a refusal here is
	// the PASS — so without reading the grant back, the contract would be
	// credited with honouring a deadline it does not implement. SEP-41
	// reports an absent allowance and an expired one identically, as zero.
	it("is UNVERIFIABLE when approve applied but stored no grant", async () => {
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(rejected("HostError: Error(Contract, #4)"));
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(
				sequencedServer([
					okResponse(100n), // holder premise
					okResponse(5n), // recipient premise
					okResponse(0n), // the grant that was never stored
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("no live grant to expire");
		// The refusal must not be read as the verdict.
		expect(result.actual).not.toContain("was refused at ledger");
	});

	// The finding: a contract that stores the amount and drops the deadline
	// leaves every approval it has ever granted permanent.
	it("FAILs when the spend succeeds against a lapsed grant", async () => {
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(APPLIED);
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(sequencedServer(PREMISE)),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("every approval it has ever granted");
		expect(result.evidence.txHash).toBe("abc123");
	});

	// A stalled network is a fact about the run, not a verdict.
	it("is UNVERIFIABLE when the ledger never passes the deadline", async () => {
		vi.spyOn(invoke, "submitWrite").mockResolvedValue(APPLIED);
		vi.useFakeTimers();
		try {
			const run = expiredAllowanceCheck.run(
				ctxWithLedger(sequencedServer(PREMISE), { stall: true }),
			);
			await vi.advanceTimersByTimeAsync(60_000);
			const result = await run;
			expect(result.status).toBe("UNVERIFIABLE");
			expect(result.actual).toContain("did not pass");
		} finally {
			vi.useRealTimers();
		}
	});

	// The wait is wall-clock time in which the holder could have spent
	// elsewhere: a refusal against a drained account says "nothing to
	// take", not "deadline enforced".
	it("is UNVERIFIABLE when the holder drained while waiting", async () => {
		vi.spyOn(invoke, "submitWrite").mockResolvedValue(APPLIED);
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(
				sequencedServer([
					okResponse(100n), // holder premise
					okResponse(5n), // recipient premise
					okResponse(1n), // grant confirmed after the approval
					okResponse(0n), // holder after the wait: drained elsewhere
					okResponse(1n),
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("drained");
		expect(result.actual).not.toContain("refused");
	});

	// Symmetric quarter: a trustline closed mid-wait refuses for asset
	// policy, not the deadline — same unknown, different reason.
	it("is UNVERIFIABLE when the recipient closed up while waiting", async () => {
		vi.spyOn(invoke, "submitWrite").mockResolvedValue(APPLIED);
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(
				sequencedServer([
					okResponse(100n), // holder premise
					okResponse(5n), // recipient premise
					okResponse(1n), // grant confirmed after the approval
					okResponse(100n), // holder after the wait: fine
					errorResponse("trustline entry is missing for account G..."), // recipient after the wait
				]),
			),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		// Named for the recipient specifically. The holder's re-read has its
		// own near-identical sentence, so a bare "unreadable after the wait"
		// passes whichever leg actually failed — and this test exists for
		// the recipient's.
		expect(result.actual).toContain(
			"recipient balance unreadable after the wait",
		);
	});

	/**
	 * The registry means "this run watched it land, so it cannot have
	 * expired". A grant built to expire is the opposite of that claim, and
	 * recording it would teach transfer_from and burn_from to treat an
	 * expired allowance as fresh — turning their honest UNVERIFIABLE into a
	 * FAIL against a contract that correctly refused a dead grant.
	 */
	it("leaves its short-lived grant out of the run registry", async () => {
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(rejected("HostError: Error(Contract, #4)"));
		const ctx = ctxWithLedger(sequencedServer(PREMISE));
		const result = await expiredAllowanceCheck.run(ctx);
		expect(result.status).toBe("PASS");
		expect(ctx.establishedAllowances.size).toBe(0);
	});

	// Setup failing says nothing about transfer_from's expiry handling.
	it("is UNVERIFIABLE when the short-lived approval will not apply", async () => {
		stubSubmit(rejected("approve refused"));
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(sequencedServer(PREMISE)),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("could not establish a short-lived");
	});

	// Only the contract's own refusal earns the PASS.

	it("is UNVERIFIABLE when the spend died on the ledger", async () => {
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(settledFailure("transaction abc failed on-chain"));
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(sequencedServer(PREMISE)),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("failed on-chain");
	});

	it("is UNVERIFIABLE when the refusal is the asset's trustline policy", async () => {
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(rejected("trustline entry is missing for G..."));
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(sequencedServer(PREMISE)),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("trustline policy");
	});

	// Premise guards. None is a verdict about the contract.

	it("is UNVERIFIABLE without both keys", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await expiredAllowanceCheck.run(
			writeCtx(sequencedServer([]), { spenderSigns: false }),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("both keys");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when the holder has nothing to spend", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(sequencedServer([okResponse(0n)])),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("account is empty");
		expect(submit).not.toHaveBeenCalled();
	});

	it("is UNVERIFIABLE when the spender is a generated throwaway", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = ctxWithLedger(sequencedServer([]));
		const result = await expiredAllowanceCheck.run({
			...ctx,
			parties: {
				owner: ctx.parties.owner,
				spender: { ...ctx.parties.spender, isThrowaway: true },
			},
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("discarded at exit");
		expect(submit).not.toHaveBeenCalled();
	});

	it.each([
		["holder", [2n ** 63n - 1n, 5n]],
		["spender", [100n, 2n ** 63n - 1n]],
	])("is UNVERIFIABLE when the %s is the asset issuer", async (_l, reads) => {
		const submit = stubSubmit(APPLIED);
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(sequencedServer((reads as bigint[]).map(okResponse))),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("issuer");
		expect(submit).not.toHaveBeenCalled();
	});

	it("FAILs a defective balance rather than calling it unreadable", async () => {
		const submit = stubSubmit(APPLIED);
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(sequencedServer([errorResponse("Error(Contract, #7)")])),
		);
		expect(result.status).toBe("FAIL");
		expect(result.actual).toContain("the premise cannot be established");
		expect(submit).not.toHaveBeenCalled();
	});

	it("reports NOT_IMPLEMENTED when the spec declares no transfer_from", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = ctxWithLedger(sequencedServer([]));
		const result = await expiredAllowanceCheck.run({
			...ctx,
			specFunctions: ["balance", "transfer"],
		});
		expect(result.status).toBe("NOT_IMPLEMENTED");
		expect(submit).not.toHaveBeenCalled();
	});

	// A contract with transfer_from but no approve cannot have an allowance
	// created at all, so there is nothing to expire.
	it("is UNVERIFIABLE when the contract declares no approve", async () => {
		const submit = stubSubmit(APPLIED);
		const ctx = ctxWithLedger(sequencedServer([]));
		const result = await expiredAllowanceCheck.run({
			...ctx,
			specFunctions: ["transfer_from", "balance"],
		});
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("declares no approve");
		expect(submit).not.toHaveBeenCalled();
	});
});
