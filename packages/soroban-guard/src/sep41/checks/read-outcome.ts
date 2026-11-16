/**
 * How a read check turns one returned value into a verdict.
 *
 * This is the half of a read check that has no I/O: given a decoded outcome
 * and a predicate saying what a sane value looks like, it decides PASS,
 * FAIL or UNVERIFIABLE. Writes deliberately do not share it — a write
 * asserts on the delta between two reads, not on a single return value.
 */
import type { xdr } from "@stellar/stellar-sdk";
import type { InvokeResult } from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import { type CheckMeta, classifyStanding, describeValue } from "./shared.ts";

/**
 * What a value assertion can conclude. `pass`/`null` are PASS/FAIL;
 * `unverifiable` is for spec-legal but insane values (e.g. decimals far
 * outside any plausible bound) — accusing the contract would be false, and
 * passing would bless a likely decode problem.
 */
export type AcceptResult =
	| { readonly verdict: "pass"; readonly actual: string }
	| { readonly verdict: "unverifiable"; readonly actual: string }
	| null;

/**
 * Shared outcome mapping for read-only checks. A trap is FAIL data (never
 * an exception). Restore and inconclusive both mean the call never produced
 * an answer, so both are UNVERIFIABLE with different explanations — never
 * FAIL. Otherwise `accept` decides what a sane value looks like.
 *
 * Missing functions never reach here: isDeclared() short-circuits them to
 * NOT_IMPLEMENTED from ctx.specFunctions before any simulation. Do NOT
 * sniff trap diagnostics for absence — that couples us to
 * RPC-version-specific error text.
 */
export function mapReadOutcome(
	meta: CheckMeta,
	expected: string,
	expectedType: xdr.ScVal["type"],
	ledger: number,
	outcome: InvokeResult,
	accept: (value: unknown) => AcceptResult,
	durationMs: number,
): CheckResult {
	if (outcome.kind === "undecodable") {
		// A map cannot satisfy a scalar return clause even if native decoding
		// failed. A failure decoding the expected type alone proves no defect.
		const wrongType = outcome.type !== expectedType;
		return {
			...meta,
			status: wrongType ? "FAIL" : "UNVERIFIABLE",
			expected,
			actual: wrongType
				? `returned ${outcome.type}, expected ${expected}`
				: "returned value could not be decoded; no contract defect established",
			evidence: { ledger, error: outcome.diagnostics },
			durationMs,
		};
	}
	if (outcome.kind === "restore" || outcome.kind === "inconclusive") {
		return {
			...meta,
			status: "UNVERIFIABLE",
			expected,
			actual:
				outcome.kind === "restore"
					? "call needs restoration; not executed"
					: "no return value observed; not executed",
			evidence: { ledger, error: outcome.diagnostics },
			durationMs,
		};
	}
	if (outcome.kind === "trapped") {
		return {
			...meta,
			status: "FAIL",
			expected,
			actual: "call trapped",
			evidence: { ledger, error: outcome.diagnostics },
			durationMs,
		};
	}
	const accepted = accept(outcome.value);
	if (accepted !== null && accepted.verdict === "unverifiable") {
		return {
			...meta,
			status: "UNVERIFIABLE",
			expected,
			actual: accepted.actual,
			evidence: { ledger },
			durationMs,
		};
	}
	if (accepted !== null) {
		return {
			...meta,
			status: "PASS",
			expected,
			actual: accepted.actual,
			evidence: { ledger },
			durationMs,
		};
	}
	return {
		...meta,
		status: "FAIL",
		expected,
		actual:
			outcome.value === null
				? `returned void, expected ${expected}`
				: `returned unexpected value ${describeValue(outcome.value)}`,
		evidence: { ledger },
		durationMs,
	};
}

/**
 * How a read phrases each standing problem.
 *
 * `null` is spelled as its own case and the fallthrough is typed `never`,
 * so adding a `StandingProblem` fails this function at compile time rather
 * than silently returning null. That default mattered: null means "not a
 * standing problem", which sends the caller on to report FAIL — so a
 * forgotten arm would accuse a conformant contract of a defect the asset's
 * own policy caused.
 */
export function noStanding(diagnostics: string): string | null {
	const standing = classifyStanding(diagnostics);
	switch (standing) {
		case "no-trustline":
			return "the address holds no trustline for this asset; point OWNER_ADDRESS at an address that holds this token";
		case "not-authorized":
			return "the address's trustline is not authorized by the asset issuer; the issuer must authorize it before any balance can be read";
		case null:
			return null;
		default:
			return unreachable(standing);
	}
}

/**
 * Assert a union was handled exhaustively.
 *
 * Reached only if a new member was added without an arm, which the compiler
 * catches first: the parameter is `never`, so the call itself fails to
 * typecheck. The throw is for the runtime that a stale build could still
 * reach — loud, rather than a wrong verdict.
 */
function unreachable(value: never): never {
	throw new Error(`unhandled case: ${String(value)}`);
}

export function noStandingTrap(
	meta: CheckMeta,
	expected: string,
	ledger: number,
	reason: string,
	diagnostics: string,
	durationMs: number,
): CheckResult {
	return {
		...meta,
		status: "UNVERIFIABLE",
		expected,
		actual: `call trapped because ${reason}`,
		evidence: { ledger, error: diagnostics },
		durationMs,
	};
}
