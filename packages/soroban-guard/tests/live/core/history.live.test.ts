import { randomBytes } from "node:crypto";
import { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { lookupOutcome } from "../../../src/core/invoke.ts";

/**
 * The proof from history against testnet's real ledger history: its
 * ledgers, each with its decoded header and metadata, and their fee bumps.
 * Candidates are picked through `getTransactions`; the proof reads ledgers.
 * Read-only.
 */
const RPC =
	process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

/**
 * A server whose first lookup by hash misses, as a lagging backend's can:
 * it answers with the real NOT_FOUND for a hash nobody sent, range and all.
 * Every later call, and the history, are the network's own.
 */
function missingOnce(): rpc.Server {
	const server = new rpc.Server(RPC);
	const real = server.getTransaction.bind(server);
	let missed = false;
	server.getTransaction = async (hash: string) => {
		if (missed) return real(hash);
		missed = true;
		return real(randomBytes(32).toString("hex"));
	};
	return server;
}

/** A window that opened at `ledger` and closed shortly after it did. */
function windowAround(ledger: number, createdAt: number) {
	return { validUntil: createdAt + 10, earliestLedger: ledger };
}

/**
 * Whether the window `windowAround` gives `tx` has closed: its deadline is
 * before the close time `page` reports for the RPC's newest ledger. A
 * receipt from near the tip leaves it open, and a lookup then rightly
 * stays pending.
 */
function windowClosed(
	tx: rpc.Api.TransactionInfo,
	page: rpc.Api.GetTransactionsResponse,
): boolean {
	return (
		windowAround(tx.ledger, tx.createdAt).validUntil <
		page.latestLedgerCloseTimestamp
	);
}

describe("lookupOutcome, on testnet", () => {
	it("proves a hash that never landed absent from recent history", async () => {
		const server = new rpc.Server(RPC);
		const hash = randomBytes(32).toString("hex");
		const seen = await server.getTransaction(hash);
		expect(seen.status).toBe(rpc.Api.GetTransactionStatus.NOT_FOUND);
		const window = {
			validUntil: Number(seen.latestLedgerCloseTime) - 60,
			earliestLedger: seen.latestLedger - 30,
		};
		await expect(lookupOutcome(server, hash, window)).resolves.toEqual({
			kind: "expired",
		});
	}, 120_000);

	it("finds a landed transaction in the history when the lookup misses", async (ctx) => {
		const server = missingOnce();
		const history = vi.spyOn(server, "getLedgers");
		const latest = await server.getLatestLedger();
		const page = await server.getTransactions({
			startLedger: latest.sequence - 20,
			pagination: { limit: 50 },
		});
		const landed = page.transactions.find((tx) => windowClosed(tx, page));
		if (landed === undefined) {
			ctx.skip("no recent transaction whose window has already closed");
			return;
		}
		history.mockClear();
		await expect(
			lookupOutcome(
				server,
				landed.txHash,
				windowAround(landed.ledger, landed.createdAt),
			),
		).resolves.toEqual({
			kind: landed.status === "SUCCESS" ? "applied" : "failed",
			ledger: landed.ledger,
		});
		// The receipt came from the ledgers, not from a lookup by hash.
		expect(history).toHaveBeenCalled();
	}, 120_000);

	it("finds a fee-bumped transaction by its inner hash", async (ctx) => {
		const server = missingOnce();
		const latest = await server.getLatestLedger();
		let page = await server.getTransactions({
			startLedger: latest.sequence - 2_000,
			pagination: { limit: 200 },
		});
		let bumped: rpc.Api.TransactionInfo | undefined;
		for (let n = 0; n < 40 && bumped === undefined; n += 1) {
			const current = page;
			bumped = current.transactions.find(
				(tx) => tx.feeBump && windowClosed(tx, current),
			);
			if (bumped === undefined) {
				page = await server.getTransactions({
					pagination: { cursor: page.cursor, limit: 200 },
				});
			}
		}
		const result = bumped?.resultXdr.result;
		if (
			bumped === undefined ||
			(result?.type !== "txFeeBumpInnerSuccess" &&
				result?.type !== "txFeeBumpInnerFailed")
		) {
			ctx.skip(
				"no fee-bumped transaction whose window has closed in recent history",
			);
			return;
		}
		const inner = String(result.innerResultPair.transactionHash);
		expect(inner).not.toBe(bumped.txHash);
		await expect(
			lookupOutcome(
				server,
				inner,
				windowAround(bumped.ledger, bumped.createdAt),
			),
		).resolves.toEqual({
			kind: bumped.status === "SUCCESS" ? "applied" : "failed",
			ledger: bumped.ledger,
		});
	}, 240_000);
});
