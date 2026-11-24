import type { rpc } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The second party a browser run supplies — the paths no live run
 * exercises, because on a healthy testnet setup always succeeds.
 */
vi.mock("soroban-guard/src/core/funding.ts", () => ({
	fundAccountInLedger: vi.fn(),
}));

const { fundAccountInLedger } = await import(
	"soroban-guard/src/core/funding.ts"
);
const { spenderParty } = await import("../src/scripts/run.ts");

const PASS = "Test SDF Network ; September 2015";
const REQUEST = {
	contractId: "CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54",
	rpcUrl: "https://example.invalid",
	networkPassphrase: PASS,
	ownerAddress: "GAFD36WZNOJ4NBHB25QL6XRU2OYNIQC3IEUAXPIQ7FVDYLJE5H5ZVQ5G",
};
// Never reached on these paths: setup fails, or is skipped, before either
// is used.
const server = {} as rpc.Server;
const source = {} as Awaited<ReturnType<rpc.Server["getAccount"]>>;

beforeEach(() => {
	vi.mocked(fundAccountInLedger).mockReset();
});

describe("spenderParty", () => {
	// Setup trouble costs the checks that need a usable second account, not
	// the whole run: the reads and the holder's other writes still run.
	it("falls back to a keyless address when setup fails", async () => {
		vi.mocked(fundAccountInLedger).mockRejectedValue(
			new Error("friendbot is down"),
		);
		const stages: string[] = [];
		const result = await spenderParty(REQUEST, server, source, false, (s) =>
			stages.push(s),
		);
		expect(result.setupFailed).toBe("friendbot is down");
		expect(result.temporary).toBeUndefined();
		expect(result.party.signer).toBeUndefined();
		// Throwaway, so the suite refuses to send anyone's units to it and
		// reports what the four checks would need.
		expect(result.party.isThrowaway).toBe(true);
		expect(result.party.address).toMatch(/^G[A-Z2-7]{55}$/);
		// Not the account setup tried to fund: that funding may still land.
		expect(result.party.address).not.toBe(
			vi.mocked(fundAccountInLedger).mock.calls[0]?.[1],
		);
	});

	it("uses a named counterparty as given, creating nothing", async () => {
		const named = "GDMEI62DG7T56E2CRGHQBK66ZT73ITHV5VMNCUZUQLO53RHUAPVDGCDU";
		const result = await spenderParty(
			{ ...REQUEST, spenderAddress: ` ${named} ` },
			server,
			source,
			false,
		);
		expect(fundAccountInLedger).not.toHaveBeenCalled();
		expect(result.party).toEqual({ address: named, isThrowaway: false });
		expect(result.temporary).toBeUndefined();
		expect(result.setupFailed).toBeUndefined();
	});

	// A custom token is never asked for a trustline: with setup otherwise
	// succeeding, no asset is read and the temporary account signs.
	it("creates a signing account for a custom token without a trustline", async () => {
		vi.mocked(fundAccountInLedger).mockResolvedValue(undefined);
		const stages: string[] = [];
		const result = await spenderParty(REQUEST, server, source, false, (s) =>
			stages.push(s),
		);
		expect(result.setupFailed).toBeUndefined();
		expect(result.party.signer).toBeDefined();
		expect(result.party.isThrowaway).toBe(false);
		expect(result.temporary?.asset).toBeUndefined();
		expect(stages.some((s) => s.includes("trustline"))).toBe(false);
	});
});
