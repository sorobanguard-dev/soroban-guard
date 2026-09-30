import type { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
	looksLikeAccountId,
	looksLikeContractId,
	sponsorship,
} from "../src/scripts/run.ts";

/**
 * Only the browser-specific logic is pinned here. The sixteen checks are
 * imported from `soroban-guard`, which tests them against stubbed RPC in
 * its own suite — re-asserting their verdicts from this package would
 * duplicate that coverage and drift from it.
 *
 * What is this package's own is the pre-flight: an address is validated
 * before any network call so a typo reports as a typo rather than as an
 * unreachable contract ten seconds later.
 */

describe("looksLikeContractId", () => {
	it("accepts a real testnet contract id", () => {
		expect(
			looksLikeContractId(
				"CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM",
			),
		).toBe(true);
	});

	it("tolerates the whitespace a paste carries", () => {
		expect(
			looksLikeContractId(
				"  CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM\n",
			),
		).toBe(true);
	});

	// A G-address is the single most likely wrong paste: same alphabet,
	// same length, different thing entirely.
	it("rejects an account address", () => {
		expect(
			looksLikeContractId(
				"GDMEI62DG7T56E2CRGHQBK66ZT73ITHV5VMNCUZUQLO53RHUAPVDGCDU",
			),
		).toBe(false);
	});

	it.each([
		["empty", ""],
		["too short", "CA5UTUUP"],
		["lowercase", "ca5utuuphyl5k22ubruvc37earzugyosgk3ikixg2jlcc5zzli4bdwdm"],
		// 0, 1, 8 and 9 are not in the base32 alphabet strkey uses.
		["contains 0", "CA0UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWD0"],
	])("rejects %s", (_label, value) => {
		expect(looksLikeContractId(value)).toBe(false);
	});

	// The reason this validator decodes strkey rather than matching a shape:
	// both of these are 56 characters from the right alphabet starting with
	// C, so `/^C[A-Z2-7]{55}$/` accepts them. Strkey carries a CRC16, so a
	// mistyped character is caught here instead of ten seconds later as an
	// RPC failure the page explicitly wants to avoid.
	it.each([
		["right shape, no checksum", `C${"A".repeat(55)}`],
		[
			"one character transposed",
			"CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWMD",
		],
	])("rejects a well-formed id whose checksum fails: %s", (_label, value) => {
		expect(/^C[A-Z2-7]{55}$/.test(value)).toBe(true);
		expect(looksLikeContractId(value)).toBe(false);
	});
});

describe("looksLikeAccountId", () => {
	it("accepts a real account address", () => {
		expect(
			looksLikeAccountId(
				"GDMEI62DG7T56E2CRGHQBK66ZT73ITHV5VMNCUZUQLO53RHUAPVDGCDU",
			),
		).toBe(true);
	});

	it("tolerates the whitespace a paste carries", () => {
		expect(
			looksLikeAccountId(
				"\tGDMEI62DG7T56E2CRGHQBK66ZT73ITHV5VMNCUZUQLO53RHUAPVDGCDU  ",
			),
		).toBe(true);
	});

	it.each([
		["empty", ""],
		["too short", "GDMEI62D"],
		["lowercase", "gdmei62dg7t56e2crghqbk66zt73ithv5vmncuzuqlo53rhuapvdgcdu"],
		// A secret key has the same length and alphabet; pasting one here
		// must never be accepted as an address.
		["a secret key", `S${"A".repeat(55)}`],
		["right shape, no checksum", `G${"A".repeat(55)}`],
	])("rejects %s", (_label, value) => {
		expect(looksLikeAccountId(value)).toBe(false);
	});

	// The mirror of the case above: a contract id in the counterparty field
	// would otherwise reach the suite and fail as an unreadable balance.
	it("rejects a contract id", () => {
		expect(
			looksLikeAccountId(
				"CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM",
			),
		).toBe(false);
	});
});

describe("sponsorship", () => {
	// Most accounts carry no extension data: reserves are simply
	// 2 + subentries, and there is nothing to add or subtract.
	it("is zero without extension data", () => {
		const entry = { ext: { type: "v0" } } as unknown as xdr.AccountEntry;
		expect(sponsorship(entry)).toEqual({ numSponsoring: 0, numSponsored: 0 });
	});

	it("is zero for a v1 entry without v2", () => {
		const entry = {
			ext: { type: "v1", v1: { ext: { type: "v0" } } },
		} as unknown as xdr.AccountEntry;
		expect(sponsorship(entry)).toEqual({ numSponsoring: 0, numSponsored: 0 });
	});

	it("reads v2 counters when present", () => {
		const entry = {
			ext: {
				type: "v1",
				v1: {
					ext: { type: "v2", v2: { numSponsoring: 3, numSponsored: 1 } },
				},
			},
		} as unknown as xdr.AccountEntry;
		expect(sponsorship(entry)).toEqual({ numSponsoring: 3, numSponsored: 1 });
	});
});
