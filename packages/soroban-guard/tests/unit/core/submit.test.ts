import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitWrite } from "../../../src/core/invoke.ts";

/**
 * What a write's outcome is, by the phase an error happens in.
 *
 * Before sending (build, sign) nothing has left the process: a contract
 * refusal is a verdict, anything else a harness failure. Once sent, no
 * error is the contract refusing — the transaction either applied, failed
 * on the ledger, provably expired, or its outcome is unknown, and the
 * signed hash is the handle on it.
 */
const SIGNED = new Uint8Array(32).fill(0xab);
const HASH = "ab".repeat(32);
const VALID_UNTIL = 1_000;
const FAST = { pollIntervalMs: 0, giveUpAfterMs: 50 };

const call = {
	contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
	method: "transfer",
	args: [],
	signer: { address: Keypair.random().publicKey() },
} as unknown as Parameters<typeof submitWrite>[1];

type Seen = {
	status: string;
	ledger?: number;
	latestLedgerCloseTime?: string;
	oldestLedger?: number;
};

/** An RPC whose send and lookups answer as each test needs. */
function network({
	send = async () => ({ status: "PENDING", hash: HASH }),
	lookups = [],
}: {
	send?: () => Promise<unknown>;
	lookups?: (Seen | Error)[];
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
	} as unknown as rpc.Server & {
		sendTransaction: ReturnType<typeof vi.fn>;
		getTransaction: ReturnType<typeof vi.fn>;
	};
}

/** A built transaction; `sign` can fail the way the SDK does. */
function built(sign: () => Promise<void> = async () => {}) {
	const fake = {
		signed: undefined as unknown,
		simulation: { latestLedger: 120 },
		sign: vi.fn(async () => {
			await sign();
			fake.signed = {
				hash: () => SIGNED,
				timeBounds: { minTime: "0", maxTime: String(VALID_UNTIL) },
			};
		}),
	};
	return vi
		.spyOn(AssembledTransaction, "build")
		.mockResolvedValue(fake as unknown as AssembledTransaction<never>);
}

const SUCCESS = { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 7 };
const NOT_FOUND_YET = {
	status: rpc.Api.GetTransactionStatus.NOT_FOUND,
	latestLedgerCloseTime: String(VALID_UNTIL - 10),
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("submitWrite, before sending", () => {
	it("reports a contract refusal surfacing at sign as rejected, not sent", async () => {
		built(async () => {
			throw new Error(
				'Transaction simulation failed: "HostError: Error(Contract, #1)"',
			);
		});
		const server = network({});
		await expect(
			submitWrite(server, call, Networks.TESTNET, FAST),
		).resolves.toMatchObject({ kind: "rejected", settled: false });
		expect(server.sendTransaction).not.toHaveBeenCalled();
	});

	it("reports archived state as restore", async () => {
		built(async () => {
			throw new AssembledTransaction.Errors.ExpiredState("restore first");
		});
		await expect(
			submitWrite(network({}), call, Networks.TESTNET, FAST),
		).resolves.toMatchObject({ kind: "restore" });
	});

	it("propagates a harness failure before anything was sent", async () => {
		built(async () => {
			throw new TypeError("fetch failed");
		});
		await expect(
			submitWrite(network({}), call, Networks.TESTNET, FAST),
		).rejects.toThrow("fetch failed");
	});

	// The request timeout only helps if writes use the server that has it.
	it("hands the caller's bounded server to the transaction builder", async () => {
		const spy = built();
		const server = network({ lookups: [SUCCESS] });
		await submitWrite(server, call, Networks.TESTNET, FAST);
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
				FAST,
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
				FAST,
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
				FAST,
			),
		).resolves.toEqual({ kind: "timeout", txHash: HASH });
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
				FAST,
			),
		).resolves.toMatchObject({ kind: "applied", txHash: HASH });
	});

	it.each(["ERROR", "TRY_AGAIN_LATER"])(
		"treats a %s send as known not applied, not unknown",
		async (status) => {
			built();
			const server = network({ send: async () => ({ status, hash: HASH }) });
			await expect(
				submitWrite(server, call, Networks.TESTNET, FAST),
			).rejects.toThrow(status);
			expect(server.getTransaction).not.toHaveBeenCalled();
		},
	);

	// A polling error is never the contract's answer, whatever its text.
	it("never reads a polling error mentioning HostError as a refusal", async () => {
		built();
		await expect(
			submitWrite(
				network({
					lookups: [new Error("HostError: Error(Contract, #1)")],
				}),
				call,
				Networks.TESTNET,
				FAST,
			),
		).resolves.toEqual({ kind: "timeout", txHash: HASH });
	});

	it("reports an unknown outcome when lookups never answer", async () => {
		built();
		await expect(
			submitWrite(
				network({ lookups: [new TypeError("fetch failed")] }),
				call,
				Networks.TESTNET,
				FAST,
			),
		).resolves.toEqual({ kind: "timeout", txHash: HASH });
	});

	// Past the validity window and not found: no ledger can include it.
	it("treats a transaction the network let expire as known not applied", async () => {
		built();
		await expect(
			submitWrite(
				network({
					lookups: [
						{
							status: rpc.Api.GetTransactionStatus.NOT_FOUND,
							latestLedgerCloseTime: String(VALID_UNTIL + 5),
							oldestLedger: 121,
						},
					],
				}),
				call,
				Networks.TESTNET,
				FAST,
			),
		).rejects.toThrow("expired without being included");
	});
	it("stays unknown when retained history starts after the validity window began", async () => {
		built();
		await expect(
			submitWrite(
				network({
					lookups: [
						{
							status: rpc.Api.GetTransactionStatus.NOT_FOUND,
							latestLedgerCloseTime: String(VALID_UNTIL + 5),
							oldestLedger: 125,
						},
					],
				}),
				call,
				Networks.TESTNET,
				FAST,
			),
		).resolves.toEqual({ kind: "timeout", txHash: HASH });
	});
});
