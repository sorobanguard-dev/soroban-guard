import { describe, expect, it } from "vitest";
import {
	isWriteSafePassphrase,
	TESTNET_PASSPHRASE,
	writeRefusalReason,
} from "../../../src/core/consent.ts";

/**
 * The consent model, pinned. Every other guard in this codebase protects a
 * contract from a false accusation; these protect the operator from their
 * own key.
 */

const MAINNET = "Public Global Stellar Network ; September 2015";
const TESTNET_RPC = "soroban-testnet.stellar.org";
const MAINNET_RPC = "mainnet.sorobanrpc.com";
const FUTURENET = "Test SDF Future Network ; October 2022";
const FUTURENET_RPC = "rpc-futurenet.stellar.org";

function reason(over: Partial<Parameters<typeof writeRefusalReason>[0]> = {}) {
	return writeRefusalReason({
		willSign: true,
		passphrase: TESTNET_PASSPHRASE,
		rpcHostname: TESTNET_RPC,
		override: false,
		...over,
	});
}

describe("writeRefusalReason", () => {
	it("allows a plain testnet write", () => {
		expect(reason()).toBeNull();
	});

	// Reads sign nothing and spend nothing, so no configuration can make
	// them dangerous — the whole gate is skipped.
	it("never refuses a run that cannot sign", () => {
		expect(
			reason({
				willSign: false,
				passphrase: MAINNET,
				rpcHostname: MAINNET_RPC,
			}),
		).toBeNull();
	});

	it("refuses a non-test passphrase", () => {
		const refusal = reason({ passphrase: MAINNET, rpcHostname: MAINNET_RPC });
		expect(refusal).toContain("testnet-only");
		expect(refusal).toContain("--allow-non-testnet-write");
	});

	it("lets the override through when both halves agree", () => {
		expect(
			reason({
				passphrase: MAINNET,
				rpcHostname: MAINNET_RPC,
				override: true,
			}),
		).toBeNull();
	});

	// A mismatched pair is never legitimate: the envelope is signed for one
	// network and sent to another, and the rejection reads as the contract
	// refusing. No override, because no operator means this.
	it.each([
		["test passphrase, public endpoint", TESTNET_PASSPHRASE, MAINNET_RPC],
		["public passphrase, test endpoint", MAINNET, TESTNET_RPC],
	])("refuses a %s mismatch even with the override", (_l, passphrase, host) => {
		const refusal = reason({
			passphrase,
			rpcHostname: host,
			override: true,
		});
		expect(refusal).toContain("network mismatch");
	});

	// Two test networks are as incompatible with each other as either is
	// with the public one. A boolean write-safe comparison missed this
	// entirely — both classify as safe, so the signature sailed through.
	it.each([
		["futurenet passphrase, testnet endpoint", FUTURENET, TESTNET_RPC],
		[
			"testnet passphrase, futurenet endpoint",
			TESTNET_PASSPHRASE,
			FUTURENET_RPC,
		],
	])(
		"refuses a mismatch between two test networks: %s",
		(_l, passphrase, host) => {
			expect(reason({ passphrase, rpcHostname: host })).toContain(
				"network mismatch",
			);
		},
	);

	it("allows each test network against its own endpoint", () => {
		expect(
			reason({ passphrase: FUTURENET, rpcHostname: FUTURENET_RPC }),
		).toBeNull();
		expect(
			reason({ passphrase: TESTNET_PASSPHRASE, rpcHostname: TESTNET_RPC }),
		).toBeNull();
	});

	// The override says "I mean to sign off testnet", not "skip the sanity
	// check" — an unrelated private passphrase against a known public host
	// is still a signature aimed at the wrong network.
	it("refuses an unrelated passphrase on a known host even with the override", () => {
		expect(
			reason({
				passphrase: "Some Private Network ; 2026",
				rpcHostname: MAINNET_RPC,
				override: true,
			}),
		).toContain("network mismatch");
	});

	// Self-hosted RPC is the normal case, not a suspicious one.
	it("leaves an unrecognised host alone", () => {
		expect(reason({ rpcHostname: "rpc.internal.example" })).toBeNull();
		expect(
			reason({
				passphrase: MAINNET,
				rpcHostname: "rpc.internal.example",
				override: true,
			}),
		).toBeNull();
	});

	// `stellar.org.` is legal DNS and resolves identically, so a trailing
	// dot must not slip past the comparison. URL already handles case and
	// port, but the fully-qualified form reaches us intact.
	it.each([
		`${MAINNET_RPC}.`,
		MAINNET_RPC.toUpperCase(),
		`${MAINNET_RPC.toUpperCase()}.`,
	])("canonicalises the host before matching: %s", (host) => {
		expect(reason({ rpcHostname: host })).toContain("network mismatch");
	});

	it("names both halves so the operator can tell which to fix", () => {
		const refusal = reason({ rpcHostname: MAINNET_RPC });
		expect(refusal).toContain(TESTNET_PASSPHRASE);
		expect(refusal).toContain(MAINNET_RPC);
	});
});

describe("isWriteSafePassphrase", () => {
	it.each([
		TESTNET_PASSPHRASE,
		"Test SDF Future Network ; October 2022",
		// Quickstart's local node, so running against a container still works.
		"Standalone Network ; February 2017",
	])("accepts a test network: %s", (passphrase) => {
		expect(isWriteSafePassphrase(passphrase)).toBe(true);
	});

	it.each([
		MAINNET,
		// Near-misses must not pass: the passphrase is network identity, and
		// a substring match would be a way onto the wrong chain.
		"Test SDF Network ; September 2016",
		"test sdf network ; september 2015",
		` ${TESTNET_PASSPHRASE} `,
		"",
	])("rejects anything else: %s", (passphrase) => {
		expect(isWriteSafePassphrase(passphrase)).toBe(false);
	});
});
