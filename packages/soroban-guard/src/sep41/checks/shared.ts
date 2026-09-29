/**
 * Machinery every SEP-41 check needs, whether it reads or writes: check
 * identity, the spec short-circuit, the chain call, and standing
 * classification.
 */
import { Asset, rpc, type xdr } from "@stellar/stellar-sdk";
import {
	type InvokeResult,
	interpretSimulation,
	type SubmitResult,
	simulateRead,
} from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import type { Sep41Context } from "../context.ts";

/** The identity fields a check declares once and stamps onto every result. */
export type CheckMeta = Pick<
	CheckResult,
	"id" | "clause" | "layer" | "requirement"
>;

/**
 * Whether the contract declares this member. A WASM contract's spec is
 * authoritative, so a missing member is answered without spending a
 * simulation. `null` means the spec is undeterminable (a SAC has none) —
 * proceed and judge the call on its own terms.
 */
export function isDeclared(ctx: Sep41Context, method: string): boolean {
	return ctx.specFunctions === null || ctx.specFunctions.includes(method);
}

/**
 * Absence is an interface verdict, not a behavior one — so this reports
 * under the interface layer whatever layer the check itself belongs to.
 */
export function notImplemented(
	meta: CheckMeta,
	method: string,
	durationMs: number,
): CheckResult {
	return {
		...meta,
		layer: "interface",
		status: "NOT_IMPLEMENTED",
		expected: `${method}() is implemented`,
		actual: `contract spec declares no '${method}'`,
		evidence: {},
		durationMs,
	};
}

/**
 * The two verdicts every check builds by hand, bound once to the check's
 * identity so call sites state only what differs: the sentence and the
 * clock.
 *
 * Six checks carried byte-identical copies of these before this existed.
 * They are structural, not domain logic — they encode the *shape* of a
 * verdict, which is one fact about the system, so divergence between
 * copies would be a bug rather than an evolution.
 *
 * `failed` takes evidence rather than a bare error string: a FAIL is the
 * finding the tool exists to produce, and a reader needs the txHash to
 * chase it.
 */
export function verdictHelpers(meta: CheckMeta, expected: string) {
	return {
		/**
		 * No verdict was reached.
		 *
		 * An absent `error` yields `{}` rather than `{ error: undefined }`.
		 * The text report renders the same either way (it guards on
		 * `!== undefined`), so this is about the evidence object itself:
		 * JSON output and equality checks distinguish an absent key from a
		 * present undefined one, and "we recorded no error" is the honest
		 * shape. No test pins this — it is a representation choice, not
		 * behavior.
		 */
		unverifiable(
			actual: string,
			durationMs: number,
			/**
			 * A diagnostic string, or the whole evidence bag when there is
			 * more to record than one.
			 *
			 * The string form is what most call sites want and stays the
			 * default. But a submission that reached the ledger and failed
			 * there carries a transaction hash, and the string-only
			 * signature was silently dropping it at six sites — a reader
			 * told the write "failed on-chain" with nothing to look it up
			 * by. Widening here fixes all six rather than teaching each to
			 * hand-roll a literal.
			 */
			evidence?: string | CheckResult["evidence"],
		): CheckResult {
			return {
				...meta,
				status: "UNVERIFIABLE",
				expected,
				actual,
				evidence:
					evidence === undefined
						? {}
						: typeof evidence === "string"
							? { error: evidence }
							: evidence,
				durationMs,
			};
		},
		/**
		 * The contract is non-conformant. Evidence is a full bag, not a bare
		 * error string, because a FAIL is the finding the tool exists to
		 * produce and a reader needs the txHash to chase it.
		 */
		failed(
			actual: string,
			durationMs: number,
			evidence: CheckResult["evidence"] = {},
		): CheckResult {
			return {
				...meta,
				status: "FAIL",
				expected,
				actual,
				evidence,
				durationMs,
			};
		},
	};
}

/**
 * Simulate one read and decode the outcome. Every check reaches the chain
 * through here; `ledger` is the node's latest at observation time, which is
 * evidence for reads since they apply nothing.
 */
export async function callRead(
	ctx: Sep41Context,
	method: string,
	args: readonly xdr.ScVal[],
): Promise<{
	readonly outcome: InvokeResult;
	readonly ledger: number;
	/**
	 * True when the answer came from an archived entry that needs
	 * restoration. Reads may use such an answer — it is what the contract
	 * returned — but it is last-known state, not current state, so anything
	 * comparing two observations must not use it as a baseline.
	 */
	readonly fromArchive: boolean;
}> {
	const sim = await simulateRead(
		ctx.server,
		ctx.source,
		{ contractId: ctx.contractId, method, args },
		ctx.networkPassphrase,
	);
	return {
		outcome: interpretSimulation(sim),
		ledger: sim.latestLedger,
		fromArchive: rpc.Api.isSimulationRestore(sim),
	};
}

/**
 * What to report when a write reached the ledger and failed there.
 *
 * Not a refusal by the contract: the transaction may have run out of fee,
 * lost a sequence race, or had its footprint expire before inclusion —
 * none of which reached the contract's logic. The response does not say
 * which, so no verdict is available and every write check downgrades to
 * UNVERIFIABLE rather than accusing a contract that was never asked.
 *
 * One sentence shared by six branches, for the same reason
 * `classifyStanding` returns a code: the wording is the finding, and six
 * copies of it drift.
 */
export const SETTLED_FAILURE_ACTUAL =
	"the write reached the ledger and failed there rather than being refused by the contract; the cause is not recoverable from the response";

/**
 * Evidence for a setup step that did not produce something to assert on.
 *
 * A timeout that named its hash keeps it — the attempt may yet apply and a
 * reader has to look it up. A settled rejection keeps its diagnostics plus
 * whatever handle the ledger gave it. Anything without a handle yields
 * undefined, and the caller reports no evidence rather than an empty one.
 * One function for the three `_from` setups, for the usual reason: the
 * hash-dropping variant of this already shipped once.
 */
export function setupEvidence(
	result: SubmitResult,
): CheckResult["evidence"] | undefined {
	if (result.kind === "applied") {
		throw new Error("setupEvidence needs a non-applied submission");
	}
	if (result.kind === "timeout") {
		return result.txHash === "" ? undefined : { txHash: result.txHash };
	}
	if (result.kind === "restore") {
		return { error: result.diagnostics };
	}
	// Explicit, not fallthrough: a future SubmitResult kind must fail loudly
	// here rather than inherit rejected-shaped evidence, the same guarantee
	// refusal.ts makes for verdicts.
	if (result.kind !== "rejected") {
		throw new Error(
			`unhandled submission kind: ${(result as { kind: string }).kind}`,
		);
	}
	return {
		error: result.diagnostics,
		...(result.txHash === undefined ? {} : { txHash: result.txHash }),
		...(result.ledger === undefined ? {} : { ledger: result.ledger }),
	};
}

export type StandingProblem = "no-trustline" | "not-authorized";

/**
 * Why a call may have had no standing to succeed — or null when the outcome
 * is the contract's own behavior.
 *
 * A Stellar Asset Contract enforces the asset's rules alongside the token
 * interface: balances live in trustlines, and an `AUTH_REQUIRED` asset needs
 * the issuer's authorization. A call tripping either never had standing, so
 * treating it as a defect accuses a conformant token.
 *
 * Matching on diagnostic text is what this codebase otherwise avoids, and it
 * is deliberate here: nothing else knows the reason, and it fails safe —
 * an unmatched string falls through to the verdict we would have reported
 * anyway, and a match only ever downgrades an accusation to "unknown". The
 * patterns are the SAC host's own wording rather than a bare "not
 * authorized", which appears in custom-token panics where the refusal *is*
 * the verdict.
 *
 * Returns a code, not a sentence: reads and writes phrase the same finding
 * differently, and two copies of these patterns would drift.
 */
export function classifyStanding(diagnostics: string): StandingProblem | null {
	if (/trustline entry is missing/i.test(diagnostics)) {
		return "no-trustline";
	}
	if (/balance is deauthorized|trustline is deauthorized/i.test(diagnostics)) {
		return "not-authorized";
	}
	return null;
}

/**
 * Whether a refusal is the Stellar Asset Contract declining an operation it
 * never offers for the native asset.
 *
 * The SAC gates `burn` and `burn_from` on `check_non_native`, which matches
 * `AssetInfo::Native` and returns `OperationNotSupportedError` with this
 * exact wording. XLM therefore cannot be burned through the token
 * interface — a deliberate policy gate, not a consequence of having no
 * issuer, since `burn` is `spend_balance` plus an event and never touches
 * one.
 *
 * This does **not** change the verdict. SEP-41 declares `burn`
 * unconditionally, with no exemption in its text, so a contract refusing it
 * fails the clause as written and downgrading that would hide a real
 * deviation — one the spec arguably owns, since it also asserts "the
 * Stellar Asset contract would implement the interface", which is false
 * here. What it changes is the sentence: a reader pointing the tool at the
 * ecosystem's canonical asset deserves to know the refusal is a known
 * property rather than a defect they can act on.
 *
 * Matched on the host's wording, like `classifyStanding` and with the same
 * caveat: a custom token emitting this phrase would be described the same
 * way. It fails safe — the verdict is unchanged either way.
 */
export function isNativeAssetRefusal(diagnostics: string): boolean {
	return /operation invalid on native asset/i.test(diagnostics);
}

/**
 * A decoded contract return, rendered for a report line.
 *
 * `String()` alone is not enough: scValToNative turns a Soroban map into a
 * plain object, which stringifies to "[object Object]" — no evidence at all
 * for the one verdict that has to justify itself. Objects are shown by
 * shape and bigints keep their `n`, so a reader can tell 1 from 1n. Never
 * throws: a value that resists rendering still has to produce a report.
 */
export function describeValue(value: unknown): string {
	if (value === null) {
		return "void";
	}
	if (typeof value === "bigint") {
		return `${value}n`;
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "object") {
		try {
			return JSON.stringify(value, (_key, inner) =>
				typeof inner === "bigint" ? `${inner}n` : inner,
			);
		} catch {
			return Object.prototype.toString.call(value);
		}
	}
	try {
		return String(value);
	} catch {
		return typeof value;
	}
}

/**
 * The balance a Stellar Asset Contract reports for the asset's own issuer.
 *
 * A sentinel, not a holding: per the SAC documentation, "transfers to the
 * issuer account will burn the token, while transfers from the issuer
 * account will mint", so the issuer is not a holder in either direction and
 * no delta measured against it means what it appears to. Detected by value
 * because a custom WASM token has no issuer to ask about, and a real balance
 * this size is unreachable — 922 billion units of a 7-decimal asset.
 */
export const ISSUER_SENTINEL_BALANCE = 2n ** 63n - 1n;

/**
 * Whether the contract under test is the asset transaction fees are paid
 * in — the native XLM Stellar Asset Contract — derived from its address
 * rather than asserted.
 *
 * Soroban fees are always paid in XLM by the transaction's source account,
 * so a balance measured in XLM on the signer also moves by the fee. Any
 * other asset is untouched by it, and a shortfall there is the contract's
 * own doing. Derived per network with `Asset.native().contractId` (which
 * is how `CDLZ…` on testnet and `CAS3…` on mainnet both resolve) instead
 * of a table nobody would keep current.
 */
export function isFeeAssetContract(
	contractId: string,
	networkPassphrase: string,
): boolean {
	return Asset.native().contractId(networkPassphrase) === contractId;
}
