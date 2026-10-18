/**
 * Four real CLI runs, transcribed from their `--format json` output:
 * 2026-10-18, soroban-guard 0.4.3 on Stellar testnet
 * (https://soroban-testnet.stellar.org). Nothing invented — the page
 * tallies are counted from these arrays so they cannot drift from them.
 *
 * Statuses are keyed by check id; the page pairs each id with its row in
 * check-reference rather than repeating the check list here, and asserts
 * the two orders agree, so a check added to the reference without a cell
 * below (or vice versa) fails the build instead of vanishing from the
 * page.
 */
import type { CheckStatus } from "soroban-guard/src/core/types.ts";

export interface ConformanceRun {
	/** Stable key, also used as the column's slug. */
	readonly name: string;
	/** Column header: the asset as the contract names it. */
	readonly label: string;
	readonly contractId: string;
	/** Where the wasm came from, in one sentence. */
	readonly origin: string;
	readonly originUrl?: string;
	/** The summary exactly as `--format json` counted it. */
	readonly pass: number;
	readonly fail: number;
	readonly unverifiable: number;
	readonly statuses: Record<string, CheckStatus>;
}

export const CONFORMANCE_DATE = "2026-10-18";
export const CONFORMANCE_VERSION = "0.4.3";
export const CONFORMANCE_NETWORK =
	"Stellar testnet · soroban-testnet.stellar.org";

/** The 16 check ids, in the CLI's run order. */
export const RUN_ORDER: readonly string[] = [
	"sep41-decimals",
	"sep41-balance",
	"sep41-allowance",
	"sep41-name",
	"sep41-symbol",
	"sep41-transfer_from-unauthorized",
	"sep41-transfer-zero-amount",
	"sep41-transfer-self",
	"sep41-transfer-negative-amount",
	"sep41-transfer-over-balance",
	"sep41-transfer",
	"sep41-approve",
	"sep41-transfer_from",
	"sep41-burn",
	"sep41-burn_from",
	"sep41-transfer_from-expired",
];

const P = "PASS";
const F = "FAIL";
const U = "UNVERIFIABLE";

/** Everything passes except the final expiry check, whose obstacle is the same on every implementation: see the page. */
const CLEAN_RUN: readonly CheckStatus[] = [
	P,
	P,
	P,
	P,
	P,
	P,
	P,
	P,
	P,
	P,
	P,
	P,
	P,
	P,
	P,
	U,
];

/** The native asset's divergences, in run order. */
const NATIVE_RUN: readonly CheckStatus[] = [
	P,
	P,
	P,
	P,
	P,
	P,
	F,
	F,
	P,
	P,
	U,
	P,
	U,
	F,
	F,
	U,
];

const from = (statuses: readonly CheckStatus[]) =>
	Object.fromEntries(
		RUN_ORDER.map((id, i) => [id, statuses[i]]),
	) satisfies Record<string, CheckStatus>;

const tally = (statuses: readonly CheckStatus[]) => ({
	pass: statuses.filter((s) => s === P).length,
	fail: statuses.filter((s) => s === F).length,
	unverifiable: statuses.filter((s) => s === U).length,
});

/** The four fixtures, in table order. */
export const CONFORMANCE_RUNS: readonly ConformanceRun[] = [
	{
		name: "soroban-examples",
		label: "Soroban Example Token (SET)",
		contractId: "CDABMBRIDJKHHNYHEQLE3GEINB5EKHGW62SDEXEOKNPKUF2MEJQVYLV5",
		origin:
			"stellar/soroban-examples at 03d42aa6 — the repo's token example, compiled and deployed for this table",
		originUrl: "https://github.com/stellar/soroban-examples",
		...tally(CLEAN_RUN),
		statuses: from(CLEAN_RUN),
	},
	{
		name: "openzeppelin",
		label: "OpenZeppelin Pausable Token (OZPT)",
		contractId: "CC2LCJBERJPDTD27FGLYDTWAGSKEAJN42VT6SNQPVTEGQV63ZHKBSA5H",
		origin:
			"OpenZeppelin/stellar-contracts at 33b665bc — the fungible-pausable example, compiled and deployed for this table",
		originUrl: "https://github.com/OpenZeppelin/stellar-contracts",
		...tally(CLEAN_RUN),
		statuses: from(CLEAN_RUN),
	},
	{
		name: "sac-native",
		label: "Native XLM (SAC)",
		contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
		origin:
			"the protocol's asset contract for XLM, as the network itself deploys it",
		...tally(NATIVE_RUN),
		statuses: from(NATIVE_RUN),
	},
	{
		name: "sac-test",
		label: "Custom-asset SAC (TEST)",
		contractId: "CARQGEM3RDSWA2SRZDL6LDBOEQWQHS74BOL5V62QXIGMOBIMIX5YTYYN",
		origin:
			"the protocol's asset contract for a custom asset, deployed on testnet",
		...tally(CLEAN_RUN),
		statuses: from(CLEAN_RUN),
	},
];
