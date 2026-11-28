import { sep41Suite } from "../src/sep41/index.ts";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateSignedTestnetReport(
	report: unknown,
	contractId: string,
	exit: number | null,
): number {
	if (
		!isObject(report) ||
		report.schema !== "soroban-guard/report@1" ||
		report.standard !== sep41Suite.standard ||
		!Array.isArray(report.results) ||
		!isObject(report.summary)
	) {
		throw new Error(
			"Expected a SEP-41 report with schema soroban-guard/report@1.",
		);
	}
	if (report.contractId !== contractId) {
		throw new Error("The report describes a different contract.");
	}

	const missing = new Set(sep41Suite.checks.map(({ id }) => id));
	const total = missing.size;
	const problems: string[] = [];
	let passing = 0;
	for (const row of report.results as unknown[]) {
		if (
			!isObject(row) ||
			typeof row.id !== "string" ||
			typeof row.status !== "string" ||
			typeof row.actual !== "string"
		) {
			problems.push("The report contains a malformed check result.");
			continue;
		}
		if (!missing.delete(row.id)) {
			problems.push(`Unexpected or duplicate check ${row.id}.`);
		}
		if (row.status === "PASS") {
			passing += 1;
		} else {
			problems.push(`${row.id} ${row.status} — ${row.actual}`);
		}
	}
	for (const id of missing) {
		problems.push(`Missing check ${id}.`);
	}
	if (
		report.summary.total !== report.results.length ||
		report.summary.pass !== passing
	) {
		problems.push("The report summary disagrees with the check results.");
	}
	if (report.exitCode !== exit) {
		problems.push(
			`CLI exit ${exit} disagrees with report exit ${report.exitCode}.`,
		);
	} else if (exit !== 0) {
		problems.push(`Expected CLI exit 0, received ${exit}.`);
	}
	if (problems.length > 0) {
		throw new Error(problems.join("\n"));
	}
	return total;
}
