/**
 * Real CLI runs, read from the `--format json` reports committed beside
 * this file in `results/`. Nothing is transcribed: every cell, tally and
 * transaction link on /results comes from those files, and each report is
 * checked as it loads — a missing check, a duplicate, a contract id that
 * does not match its column, or a summary that disagrees with its own
 * rows fails the build instead of publishing a wrong table.
 *
 * The reports carry no tool version, so the version they were produced
 * with is recorded here, beside them.
 */
import type { CheckStatus } from "soroban-guard/src/core/types.ts";
import ozpt from "./results/ozpt.json";
import set from "./results/set.json";
import test from "./results/test.json";

/** The tool version that produced the reports in `results/`. */
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

/** The shape of a `soroban-guard/report@1` document, as far as this page reads it. */
interface Report {
	readonly schema: string;
	readonly contractId: string;
	readonly ranAt: string;
	readonly exitCode: number;
	readonly summary: {
		readonly total: number;
		readonly pass: number;
		readonly fail: number;
		readonly unverifiable: number;
	};
	readonly results: readonly {
		readonly id: string;
		readonly status: string;
		readonly actual: string;
		readonly evidence?: { readonly txHash?: string };
	}[];
}

export interface Cell {
	readonly status: CheckStatus;
	/** The check's own one-line finding, verbatim from the report. */
	readonly actual: string;
	/** The settled transaction behind a write, when the check made one. */
	readonly txHash?: string;
}

export interface ConformanceRun {
	/** Stable key, also the report's file name. */
	readonly name: string;
	/** Column header: the asset as the contract names it. */
	readonly label: string;
	readonly contractId: string;
	/** Where the wasm came from, in one sentence. */
	readonly origin: string;
	readonly originUrl?: string;
	readonly ranAt: string;
	readonly exitCode: number;
	readonly pass: number;
	readonly fail: number;
	readonly unverifiable: number;
	readonly cells: Readonly<Record<string, Cell>>;
}

const STATUSES: readonly CheckStatus[] = [
	"PASS",
	"FAIL",
	"UNVERIFIABLE",
	"SKIPPED",
	"NOT_IMPLEMENTED",
];

/** Read one report, refusing anything the table could misstate. */
export function fromReport(
	column: Pick<
		ConformanceRun,
		"name" | "label" | "contractId" | "origin" | "originUrl"
	>,
	report: Report,
): ConformanceRun {
	const fail = (why: string) => {
		throw new Error(`conformance-table: ${column.name}.json ${why}`);
	};
	if (report.schema !== "soroban-guard/report@1") {
		fail(`has schema ${report.schema}`);
	}
	if (report.contractId !== column.contractId) {
		fail(`is a report for ${report.contractId}, not ${column.contractId}`);
	}
	const cells: Record<string, Cell> = {};
	for (const result of report.results) {
		if (!STATUSES.includes(result.status as CheckStatus)) {
			fail(`gives ${result.id} the unknown status ${result.status}`);
		}
		if (result.id in cells) {
			fail(`reports ${result.id} twice`);
		}
		const txHash = result.evidence?.txHash;
		cells[result.id] = {
			status: result.status as CheckStatus,
			actual: result.actual,
			...(txHash === undefined ? {} : { txHash }),
		};
	}
	const ids = Object.keys(cells);
	const missing = RUN_ORDER.filter((id) => !(id in cells));
	const extra = ids.filter((id) => !RUN_ORDER.includes(id));
	if (missing.length > 0 || extra.length > 0) {
		fail(
			`does not match the check set (missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"})`,
		);
	}
	const count = (status: CheckStatus) =>
		Object.values(cells).filter((cell) => cell.status === status).length;
	const tally = {
		pass: count("PASS"),
		fail: count("FAIL"),
		unverifiable: count("UNVERIFIABLE"),
	};
	const { summary } = report;
	if (
		summary.total !== ids.length ||
		summary.pass !== tally.pass ||
		summary.fail !== tally.fail ||
		summary.unverifiable !== tally.unverifiable
	) {
		fail("has a summary that disagrees with its own rows");
	}
	return {
		...column,
		ranAt: report.ranAt,
		exitCode: report.exitCode,
		...tally,
		cells,
	};
}

/** The runs, in table order. */
export const CONFORMANCE_RUNS: readonly ConformanceRun[] = [
	fromReport(
		{
			name: "set",
			label: "Soroban Example Token (SET)",
			contractId: "CDABMBRIDJKHHNYHEQLE3GEINB5EKHGW62SDEXEOKNPKUF2MEJQVYLV5",
			origin:
				"stellar/soroban-examples at 03d42aa6 — the repo's token example, compiled and deployed for this table",
			originUrl: "https://github.com/stellar/soroban-examples",
		},
		set,
	),
	fromReport(
		{
			name: "ozpt",
			label: "OpenZeppelin Pausable Token (OZPT)",
			contractId: "CC2LCJBERJPDTD27FGLYDTWAGSKEAJN42VT6SNQPVTEGQV63ZHKBSA5H",
			origin:
				"OpenZeppelin/stellar-contracts at 33b665bc — the fungible-pausable example, compiled and deployed for this table",
			originUrl: "https://github.com/OpenZeppelin/stellar-contracts",
		},
		ozpt,
	),
	fromReport(
		{
			name: "test",
			label: "Custom-asset SAC (TEST)",
			contractId: "CARQGEM3RDSWA2SRZDL6LDBOEQWQHS74BOL5V62QXIGMOBIMIX5YTYYN",
			origin:
				"the protocol's asset contract for a custom asset, deployed on testnet",
		},
		test,
	),
];

/** The day the runs were made, from the reports themselves. */
export const CONFORMANCE_DATE = (() => {
	const days = new Set(CONFORMANCE_RUNS.map((run) => run.ranAt.slice(0, 10)));
	return [...days].sort().join(" – ");
})();
