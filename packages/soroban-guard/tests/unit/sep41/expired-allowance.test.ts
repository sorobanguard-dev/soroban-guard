import {
	Account,
	type rpc,
	scValToNative,
	type Transaction,
	xdr,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as invoke from "../../../src/core/invoke.ts";
import { expiredAllowanceCheck } from "../../../src/sep41/checks/expired-allowance.ts";
import type { Sep41Context } from "../../../src/sep41/context.ts";
import {
	APPLIED,
	answerlessSuccess,
	contractRefusal,
	okResponse,
	rejected,
	sequencedServer,
	settledFailure,
	stubSubmit,
	testTrustlineMissing,
	WRITE_LEDGER,
	withFields,
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
		getAccount: vi.fn(async (address: string) => new Account(address, "7")),
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

function spendRefused(diagnostics: string, simulationLedger = WRITE_LEDGER) {
	return { ...rejected(diagnostics), simulationLedger };
}

/** An answer from `ledger`: what a read-only simulation saw there. */
function at<T extends object>(response: T, ledger: number): T {
	return withFields(response, { latestLedger: ledger });
}

describe("expiredAllowanceCheck", () => {
	// The whole point: the grant lapsed, so refusing is correct.
	it("PASSes when the contract refuses a spend on a lapsed grant", async () => {
		vi.spyOn(invoke, "submitWrite")
			// The setup approval lands, then the spend is refused.
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(spendRefused("HostError: Error(Contract, #4)"));
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(sequencedServer(PREMISE)),
		);
		expect(result.status).toBe("PASS");
		expect(result.actual).toContain("expired at ledger 106");
		expect(result.actual).toContain("refused");
		expect(result.evidence.ledger).toBe(WRITE_LEDGER);
		// The evidence names the grant that was confirmed before the wait:
		// without it, the post-wait allowance alone cannot tell an expired
		// grant from one that never landed.
		expect(result.evidence.before?.granted).toBe("1");
	});

	// Testnet can take three ledgers to land and read back the approval,
	// and a grant much shorter can expire before then. Six leave room.
	it("grants six ledgers past the ledger it read", async () => {
		const submit = vi
			.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(rejected("HostError: Error(Contract, #4)"));
		await expiredAllowanceCheck.run(ctxWithLedger(sequencedServer(PREMISE)));
		const approval = submit.mock.calls[0]?.[1];
		expect(approval?.method).toBe("approve");
		expect(scValToNative(approval?.args[3] as xdr.ScVal)).toBe(106);
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
					contractRefusal(13, "trustline entry is missing for account G..."), // recipient after the wait
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
			.mockResolvedValueOnce(spendRefused("HostError: Error(Contract, #4)"));
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
			ctxWithLedger(sequencedServer([contractRefusal(7)])),
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

describe("expiredAllowanceCheck, simulated past the deadline", () => {
	afterEach(() => vi.restoreAllMocks());

	// The wait saw a ledger past the deadline, but an RPC backend still
	// before it would simulate the spend against a live grant.
	it("simulates the spend at a ledger past the one the grant expires at", async () => {
		const submit = vi
			.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce({ ...APPLIED, ledger: 101 })
			.mockResolvedValueOnce(rejected("HostError: Error(Contract, #4)"));
		await expiredAllowanceCheck.run(ctxWithLedger(sequencedServer(PREMISE)));
		expect(submit.mock.calls[1]?.[1]).toMatchObject({
			method: "transfer_from",
			minLedger: WRITE_LEDGER,
		});
	});

	// Each read after the wait asks for a ledger past the deadline on its
	// own: the holder's balance, the recipient's, and the allowance. The two
	// premises before the approval need none; the grant read back after it
	// needs the approval's ledger.
	it("holds each read after the wait to a ledger past the deadline", async () => {
		const reads = vi.spyOn(invoke, "simulateRead");
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce({ ...APPLIED, ledger: 101 })
			.mockResolvedValueOnce(rejected("HostError: Error(Contract, #4)"));
		await expiredAllowanceCheck.run(ctxWithLedger(sequencedServer(PREMISE)));
		expect(reads.mock.calls.map(([, , call]) => call.minLedger)).toEqual([
			undefined,
			undefined,
			101,
			200,
			WRITE_LEDGER,
			WRITE_LEDGER,
		]);
	});

	it("rejects a read past expiry but older than the ledger the wait observed", async () => {
		vi.useFakeTimers();
		try {
			const submit = vi
				.spyOn(invoke, "submitWrite")
				.mockResolvedValueOnce({ ...APPLIED, ledger: 101 })
				.mockResolvedValueOnce(rejected("HostError: Error(Contract, #4)"));
			const premises = PREMISE.slice(0, 3);
			const behindWait = { ...okResponse(100n), latestLedger: 107 };
			const server = {
				simulateTransaction: vi.fn(async () => premises.shift() ?? behindWait),
			} as unknown as rpc.Server;
			const running = expiredAllowanceCheck.run(ctxWithLedger(server));
			await vi.advanceTimersByTimeAsync(60_000);
			const result = await running;
			expect(result.status).toBe("UNVERIFIABLE");
			expect(result.actual).toContain("at ledger 107, before ledger 200");
			expect(submit).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	// A refusal is the deadline's only if, in the ledger it happened in, the
	// holder had the funds and the recipient its standing. Each round asks
	// for the spend, simulated read-only, and both balances at once; the
	// answers count when they share a ledger. The refusal here comes at
	// ledger R, after the post-wait reads, so the check asks again.
	const R = WRITE_LEDGER + 1;
	const refused = (ledger: number) => at(contractRefusal(4), ledger);
	const allowed = (ledger: number) =>
		at(okResponse(xdr.ScVal.scvVoid()), ledger);
	const balance = (amount: bigint, ledger: number) =>
		at(okResponse(amount), ledger);
	it.each([
		[
			"the refused spend and both balances share its ledger",
			[[refused(R), balance(100n, R), balance(5n, R)]],
			"PASS",
			R,
		],
		// Drained for the refusal, funded again a ledger later: the later
		// ledger is one consistent observation, and it shows a refusal with
		// the funds there.
		[
			"they share a later ledger, where the holder is funded again",
			[[refused(R + 1), balance(100n, R + 1), balance(5n, R + 1)]],
			"PASS",
			R + 1,
		],
		[
			"the holder was drained in that ledger",
			[[refused(R), balance(0n, R), balance(5n, R)]],
			"UNVERIFIABLE",
			R,
		],
		[
			"they share a ledger only on the second round",
			[
				[refused(R), balance(100n, R + 1), balance(5n, R)],
				[refused(R + 1), balance(100n, R + 1), balance(5n, R + 1)],
			],
			"PASS",
			R + 1,
		],
		[
			"they never share a ledger",
			Array.from({ length: 4 }, () => [
				refused(R),
				balance(100n, R + 1),
				balance(5n, R),
			]),
			"UNVERIFIABLE",
			R,
		],
		[
			"the spend is allowed in that ledger",
			[[allowed(R), balance(100n, R), balance(5n, R)]],
			"UNVERIFIABLE",
			R,
		],
		[
			"the asset's own policy refuses it in that ledger",
			[[at(testTrustlineMissing(), R), balance(100n, R), balance(5n, R)]],
			"UNVERIFIABLE",
			R,
		],
		[
			"the recipient cannot be read",
			[[refused(R), balance(100n, R), at(answerlessSuccess(), R)]],
			"UNVERIFIABLE",
			R,
		],
	])("judges a refusal where %s", async (_case, rounds, status, ledger) => {
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(spendRefused("HostError: Error(Contract, #4)", R));
		const server = sequencedServer([
			...PREMISE,
			...(rounds as rpc.Api.SimulateTransactionResponse[][]).flat(),
		]);
		const result = await expiredAllowanceCheck.run(ctxWithLedger(server));
		expect(result.status).toBe(status);
		expect(result.evidence.ledger).toBe(ledger);
	});

	// The report says which it was: a spend that would now go through, or
	// one that could not be simulated again, which says nothing either way.
	it.each([
		["allowed", allowed(R), "would be allowed at ledger"],
		[
			"not answered",
			at(answerlessSuccess(), R),
			"could not be simulated again at ledger",
		],
	])(
		"says why a spend %s in that ledger is no proof",
		async (_case, spend, said) => {
			vi.spyOn(invoke, "submitWrite")
				.mockResolvedValueOnce(APPLIED)
				.mockResolvedValueOnce(
					spendRefused("HostError: Error(Contract, #4)", R),
				);
			const server = sequencedServer([
				...PREMISE,
				spend,
				balance(100n, R),
				balance(5n, R),
			]);
			const result = await expiredAllowanceCheck.run(ctxWithLedger(server));
			expect(result.status).toBe("UNVERIFIABLE");
			expect(result.actual).toContain(said);
		},
	);

	// Both balances come back from one round, so a defect in either is the
	// contract's, whatever the other says: an unreadable one does not hide
	// it.
	it.each([
		[
			"the holder's is unreadable",
			at(answerlessSuccess(), R),
			at(okResponse(xdr.ScVal.scvU32(5)), R),
		],
		[
			"the recipient's is unreadable",
			at(okResponse(xdr.ScVal.scvU32(100)), R),
			at(answerlessSuccess(), R),
		],
	])("FAILs a defective balance when %s", async (_case, holder, recipient) => {
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(spendRefused("HostError: Error(Contract, #4)", R));
		const server = sequencedServer([...PREMISE, refused(R), holder, recipient]);
		const result = await expiredAllowanceCheck.run(ctxWithLedger(server));
		expect(result.status).toBe("FAIL");
	});

	// The spend is simulated again as it was sent, with the spender's
	// account as the source: authorization is recorded relative to it.
	it("simulates the spend again with the spender as its source", async () => {
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(spendRefused("HostError: Error(Contract, #4)", R));
		const server = sequencedServer([
			...PREMISE,
			refused(R),
			balance(100n, R),
			balance(5n, R),
		]);
		const simulated = vi.spyOn(server, "simulateTransaction");
		const ctx = ctxWithLedger(server);
		await expect(expiredAllowanceCheck.run(ctx)).resolves.toMatchObject({
			status: "PASS",
		});
		const spend = simulated.mock.calls[PREMISE.length]?.[0] as
			| Transaction
			| undefined;
		expect(spend?.source).toBe(ctx.parties.spender.address);
		expect(spend?.source).not.toBe(ctx.source.accountId());
	});

	// A balance that is not one in the refusal's ledger is the contract's
	// defect, as it is before the spend.
	it("FAILs a holder balance of the wrong type read after the refusal", async () => {
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(spendRefused("HostError: Error(Contract, #4)", R));
		const server = sequencedServer([
			...PREMISE,
			refused(R),
			at(okResponse(xdr.ScVal.scvU32(100)), R),
			balance(5n, R),
		]);
		const result = await expiredAllowanceCheck.run(ctxWithLedger(server));
		expect(result.status).toBe("FAIL");
	});

	it("credits no refusal it cannot tie to a ledger", async () => {
		vi.spyOn(invoke, "submitWrite")
			.mockResolvedValueOnce(APPLIED)
			.mockResolvedValueOnce(rejected("HostError: Error(Contract, #4)"));
		const result = await expiredAllowanceCheck.run(
			ctxWithLedger(sequencedServer(PREMISE)),
		);
		expect(result.status).toBe("UNVERIFIABLE");
		expect(result.actual).toContain("could not be tied to a ledger");
	});
});
