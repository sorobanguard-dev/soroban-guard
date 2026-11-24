import type { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	fundAccount,
	fundAccountInLedger,
	loadSourceAccount,
} from "../../../src/core/funding.ts";

const KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ABSENT = new Error("failed to find an entry for key ABCD");

function stubServer(impl: {
	getLedgerEntry?: () => Promise<unknown>;
	fundAddress?: () => Promise<unknown>;
}): rpc.Server & {
	getLedgerEntry: ReturnType<typeof vi.fn>;
	fundAddress: ReturnType<typeof vi.fn>;
} {
	return {
		getLedgerEntry: vi.fn(async () => ({})),
		fundAddress: vi.fn(async () => {}),
		...impl,
	} as unknown as rpc.Server & {
		getLedgerEntry: ReturnType<typeof vi.fn>;
		fundAddress: ReturnType<typeof vi.fn>;
	};
}

describe("fundAccount", () => {
	it("returns immediately for funded accounts without touching the faucet", async () => {
		const server = stubServer({});
		await fundAccount(server, KEY, { delayMs: 0 });
		expect(server.getLedgerEntry).toHaveBeenCalledTimes(1);
		expect(server.fundAddress).not.toHaveBeenCalled();
	});

	it("requests once, then verifies", async () => {
		let calls = 0;
		const server = stubServer({
			getLedgerEntry: vi.fn(async () => {
				calls++;
				if (calls < 2) {
					throw ABSENT;
				}
				return {};
			}),
		});
		await fundAccount(server, KEY, { delayMs: 0 });
		expect(server.fundAddress).toHaveBeenCalledTimes(1);
		expect(server.fundAddress).toHaveBeenCalledWith(KEY);
	});

	it("throws after exhausting verification attempts", async () => {
		const server = stubServer({
			getLedgerEntry: vi.fn(async () => {
				throw ABSENT;
			}),
		});
		await expect(
			fundAccount(server, KEY, { attempts: 3, delayMs: 0 }),
		).rejects.toThrow(KEY);
		// Initial check + one verification per attempt.
		expect(server.getLedgerEntry).toHaveBeenCalledTimes(4);
		expect(server.fundAddress).toHaveBeenCalledTimes(1);
	});

	it("never sleeps after the final poll", async () => {
		const sleeps: number[] = [];
		const server = stubServer({
			getLedgerEntry: vi.fn(async () => {
				throw ABSENT;
			}),
		});
		await expect(
			fundAccount(server, KEY, {
				attempts: 3,
				delayMs: 30_000,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		).rejects.toThrow();
		expect(sleeps).toEqual([30_000, 30_000]);
	});

	it("propagates faucet rejections immediately", async () => {
		const server = stubServer({
			getLedgerEntry: vi.fn(async () => {
				throw ABSENT;
			}),
			fundAddress: vi.fn(async () => {
				throw new Error("rate limited");
			}),
		});
		await expect(fundAccount(server, KEY, { delayMs: 0 })).rejects.toThrow(
			"rate limited",
		);
		expect(server.getLedgerEntry).toHaveBeenCalledTimes(1);
	});

	it("propagates transport errors without firing the faucet", async () => {
		const server = stubServer({
			getLedgerEntry: vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		});
		await expect(fundAccount(server, KEY, { delayMs: 0 })).rejects.toThrow(
			"fetch failed",
		);
		expect(server.fundAddress).not.toHaveBeenCalled();
	});

	it("propagates mid-poll transport errors without further sleeps", async () => {
		const sleeps: number[] = [];
		let calls = 0;
		const server = stubServer({
			getLedgerEntry: vi.fn(async () => {
				calls++;
				if (calls === 1) {
					throw ABSENT;
				}
				throw new TypeError("fetch failed");
			}),
		});
		await expect(
			fundAccount(server, KEY, {
				delayMs: 0,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		).rejects.toThrow("fetch failed");
		expect(sleeps).toEqual([]);
	});

	it("rejects non-positive attempts before any network call", async () => {
		const server = stubServer({});
		await expect(
			fundAccount(server, KEY, { attempts: 0, delayMs: 0 }),
		).rejects.toThrow(RangeError);
		expect(server.getLedgerEntry).not.toHaveBeenCalled();
		expect(server.fundAddress).not.toHaveBeenCalled();
	});

	it("rejects bad delays before any network call", async () => {
		const server = stubServer({});
		for (const delayMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			await expect(fundAccount(server, KEY, { delayMs })).rejects.toThrow(
				RangeError,
			);
		}
		expect(server.getLedgerEntry).not.toHaveBeenCalled();
		expect(server.fundAddress).not.toHaveBeenCalled();
	});

	it("rejects malformed keys before any network call", async () => {
		const server = stubServer({});
		await expect(
			fundAccount(server, "NOT_A_KEY", { delayMs: 0 }),
		).rejects.toThrow(RangeError);
		expect(server.getLedgerEntry).not.toHaveBeenCalled();
		expect(server.fundAddress).not.toHaveBeenCalled();
	});
});

describe("loadSourceAccount", () => {
	it("builds the sequence source from the ledger entry", async () => {
		const server = stubServer({
			getLedgerEntry: vi.fn(async () => ({
				val: { type: "account", account: { seqNum: 42n } },
			})),
		});
		const account = await loadSourceAccount(server, KEY);
		expect(account.accountId()).toBe(KEY);
		expect(account.sequenceNumber()).toBe("42");
	});

	it("propagates absence and transport errors unconverted", async () => {
		const absent = stubServer({
			getLedgerEntry: vi.fn(async () => {
				throw new Error("failed to find an entry for key ABCD");
			}),
		});
		await expect(loadSourceAccount(absent, KEY)).rejects.toThrow(
			"failed to find an entry",
		);
		const down = stubServer({
			getLedgerEntry: vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		});
		await expect(loadSourceAccount(down, KEY)).rejects.toThrow("fetch failed");
	});

	it("names the unexpected type instead of claiming absence", async () => {
		const wrongType = stubServer({
			getLedgerEntry: vi.fn(async () => ({
				val: { type: "trustline" },
			})),
		});
		await expect(loadSourceAccount(wrongType, KEY)).rejects.toThrow(
			"expected account entry",
		);
	});
});

// The run's reads after funding must describe state from the ledger it
// landed in, so the account entry the poll found says which one.
describe("fundAccountInLedger", () => {
	function fundedIn(entry: unknown) {
		let calls = 0;
		return stubServer({
			getLedgerEntry: vi.fn(async () => {
				calls++;
				if (calls < 2) {
					throw ABSENT;
				}
				return entry;
			}),
		});
	}

	// `fundAccount` keeps its public signature, resolving to nothing.
	it("leaves fundAccount resolving to nothing", async () => {
		await expect(
			fundAccount(fundedIn({ lastModifiedLedgerSeq: 150 }), KEY, {
				delayMs: 0,
			}),
		).resolves.toBeUndefined();
	});

	it("returns the ledger its funding landed in", async () => {
		await expect(
			fundAccountInLedger(fundedIn({ lastModifiedLedgerSeq: 150 }), KEY, {
				delayMs: 0,
			}),
		).resolves.toBe(150);
	});

	it("returns no ledger for an account it did not fund", async () => {
		const server = stubServer({
			getLedgerEntry: vi.fn(async () => ({ lastModifiedLedgerSeq: 99 })),
		});
		await expect(
			fundAccountInLedger(server, KEY, { delayMs: 0 }),
		).resolves.toBeUndefined();
	});

	it.each([
		["fractional", 150.5],
		["missing", undefined],
		["zero", 0],
	])("returns no ledger when the RPC's is %s", async (_case, ledger) => {
		await expect(
			fundAccountInLedger(fundedIn({ lastModifiedLedgerSeq: ledger }), KEY, {
				delayMs: 0,
			}),
		).resolves.toBeUndefined();
	});
});
