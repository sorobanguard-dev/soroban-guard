import { contract, type rpc } from "@stellar/stellar-sdk";

/**
 * What the ledger says about a contract ID. `wasm` carries the declared
 * function names; `native` (SAC and friends — no usable spec) and `missing`
 * (no instance entry at all) both mean the spec is undeterminable and
 * callers must proceed as today. `missing` additionally tells the CLI the
 * address names nothing, which is a usage error rather than a verdict.
 *
 * `stellarAsset` says whether a `native` contract is a Stellar Asset
 * Contract, from its executable: code whose spec cannot be read is
 * `native` too, and is not one.
 */
export type ContractCode =
	| { readonly kind: "missing" }
	| { readonly kind: "native"; readonly stellarAsset: boolean }
	| { readonly kind: "wasm"; readonly functions: readonly string[] };

/** No usable spec, from code that is not a Stellar Asset Contract. */
const UNREADABLE: ContractCode = { kind: "native", stellarAsset: false };

/**
 * Pure: function names declared by a parsed spec. Tested with hand-built
 * entries through the real SDK parser. `f.name` is read via String()
 * because parsed entries may carry it as an XDR String object rather than
 * a JS string — normalization is verified against a real WASM token when
 * OZ validation lands, not before.
 */
export function specFunctionNames(spec: contract.Spec): readonly string[] {
	return spec.funcs().map((fn) => String(fn.name));
}

/**
 * Numeric SDK error code when the rejection carries one (number or numeric
 * string), else null. Centralizes the shape-read so missing-detection and
 * ref-resolution never re-derive it ad hoc. Scoped to the SDK's own
 * absence vocabulary from the exactly-pinned version (all three
 * instance-fetch rejects carry code 404) — a generic /not found/i would
 * also match unrelated ledger misses.
 */
function getErrorCode(error: unknown): number | null {
	if (typeof error !== "object" || error === null) return null;
	// Numeric only: the pinned SDK writes `code: 404` as a literal at every
	// absence site in rpc/server.js. A string arm has no producer, which the
	// "exactly-pinned shapes" rule above rules out rather than tolerates.
	const code = (error as { code?: unknown }).code;
	return typeof code === "number" ? code : null;
}

function isNotFound(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	if (getErrorCode(error) === 404) {
		return true;
	}
	const record = error as Record<string, unknown>;
	return (
		typeof record.message === "string" &&
		/could not obtain contract (instance|wasm)/i.test(record.message)
	);
}

/**
 * Inspect a contract ID: existence, then spec availability. Never throws
 * for ledger states — missing instances, SAC/native executables, archived
 * code, and unparseable specs all resolve to a kind; only transport
 * failures propagate, and those are harness errors for the caller to
 * report. Callers proceed as today on anything but `missing`.
 */
export async function inspectContract(
	server: rpc.Server,
	contractId: string,
): Promise<ContractCode> {
	let instance: Awaited<ReturnType<typeof server.getContractInstance>>;
	try {
		instance = await server.getContractInstance(contractId);
	} catch (error) {
		if (isNotFound(error)) {
			return { kind: "missing" };
		}
		throw error;
	}
	// Reached only after a resolved call: an absent contract rejects here
	// (verified on testnet — a plain object with `code: 404`, not an Error)
	// and is returned as `missing` above, so `instance` is never nullish at
	// this point. `executable` keeps its optional read because the field is
	// genuinely optional on the instance type.
	const executable = instance.executable;
	if (executable?.type === "contractExecutableExternalRef") {
		// CAP-85: resolve the named hash through the SDK, mirroring
		// getContractWasmByContractId. A wrong turn here only loses the
		// NOT_IMPLEMENTED optimization (one extra simulation), never a
		// verdict — so unknown setup states fall back to native while
		// unambiguous transport (TypeError) propagates. Shape reads stay
		// outside the guarded region: only SDK calls may throw into it.
		const ref = (executable as unknown as { externalRef?: unknown })
			.externalRef;
		if (ref === undefined || ref === null) {
			return UNREADABLE;
		}
		let wasm: Uint8Array;
		try {
			wasm = await server.getContractWasmByHash(
				await server.getExternalRefWasmHash(
					ref as Parameters<typeof server.getExternalRefWasmHash>[0],
				),
			);
		} catch (error) {
			// Mirror the WASM branch, plus malformed-ref setup ({code:400}:
			// the ref names something unresolvable): both are ledger states
			// that degrade to native. Only transport failures propagate —
			// a wrong turn here loses an optimization, never a verdict.
			if (isNotFound(error) || getErrorCode(error) === 400) {
				return UNREADABLE;
			}
			throw error;
		}
		// Parsed outside the fetch guard, as on the WASM branch below: a spec
		// the SDK refuses (none, or since 17.3 more than one section) is a
		// fact about the code, not a transport failure, and must not stop
		// the run from starting.
		return specOrNative(wasm);
	}
	if (executable?.type !== "contractExecutableWasm") {
		// SAC and anything else without fetchable WASM.
		// The pinned SDK's own discriminant strings are the ground truth
		// here (see server.getContractWasmByContractId); a future SDK that
		// reshapes these arms fails typecheck at upgrade time, which is the
		// guard — no runtime string can protect against unknown shapes.
		return {
			kind: "native",
			stellarAsset: executable?.type === "contractExecutableStellarAsset",
		};
	}
	let wasm: Uint8Array;
	try {
		// Same access the SDK itself uses (server.getContractWasmByContractId).
		const hash = (executable as unknown as { value?: { value?: Uint8Array } })
			.value?.value;
		if (!(hash instanceof Uint8Array)) {
			return UNREADABLE;
		}
		wasm = await server.getContractWasmByHash(hash);
	} catch (error) {
		if (isNotFound(error)) {
			// Archived/expired code: undeterminable, proceed as today.
			return UNREADABLE;
		}
		throw error;
	}
	return specOrNative(wasm);
}

/**
 * The declared functions, or native when the SDK cannot read a spec from
 * the code. Both ways of reaching contract code end here, so they cannot
 * disagree about what an unreadable spec means.
 */
function specOrNative(wasm: Uint8Array): ContractCode {
	try {
		return {
			kind: "wasm",
			functions: specFunctionNames(contract.Spec.fromWasm(wasm)),
		};
	} catch {
		return UNREADABLE;
	}
}
