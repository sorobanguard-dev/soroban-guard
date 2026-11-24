import { type rpc, StrKey, scValToNative } from "@stellar/stellar-sdk";

/**
 * Who a failed simulation's evidence says refused the call.
 *
 * Reads and writes both ask this, so it is answered once. Only a refusal
 * by the invoked contract's own code is evidence about it: a negative
 * check can PASS on it and a positive check can FAIL on it. Anything else
 * (an error a contract it called raised, the host running out of budget, a
 * module the VM could not load, an authorization the host required, a host
 * fault) is no verdict about this contract.
 *
 * `reason` is the message the refusing error event carried, such as a
 * Stellar Asset Contract's "trustline entry is missing for account". It is
 * read from that one event, never from the rest of the trace, where any
 * log can say anything.
 */
export type SimulationFailure =
	| {
			readonly byContract: true;
			readonly error: string;
			readonly reason: string | undefined;
	  }
	| { readonly byContract: false; readonly error: string | undefined };

/** The trap a contract's own code raises: a panic, or an explicit `unreachable`. */
const METHOD_TRAP = "VM call trapped: UnreachableCodeReached";

type Event = rpc.Api.SimulateTransactionErrorResponse["events"][number];
type Value = Event["event"]["body"]["v0"]["topics"][number];
type ScError = Extract<Value, { type: "scvError" }>["error"];

function symbol(value: Value | undefined): string | undefined {
	return value?.type === "scvSymbol" ? String(value.sym) : undefined;
}

/** The contract that emitted an event, as hex. */
function emitter(event: Event): string | undefined {
	return event.event.contractId === null
		? undefined
		: String(event.event.contractId);
}

/**
 * The contract and method the simulation invoked, from the first
 * diagnostic `fn_call` event.
 */
function invokedCall(
	sim: rpc.Api.SimulateTransactionErrorResponse,
): { readonly contract: string; readonly method: string } | undefined {
	const call = sim.events.find(
		({ event }) =>
			event.type.name === "diagnostic" &&
			symbol(event.body.v0.topics[0]) === "fn_call",
	);
	if (call === undefined) return undefined;
	const [, target, invoked] = call.event.body.v0.topics;
	const method = symbol(invoked);
	return target?.type === "scvBytes" && method !== undefined
		? { contract: String(target.bytes), method }
		: undefined;
}

/** A diagnostic `error` event: who raised it, the error, and its message. */
interface ErrorEvent {
	readonly contract: string | undefined;
	readonly error: ScError;
	readonly values: readonly Value[];
}

/** The diagnostic `error` events, in the order they were emitted. */
function errorEvents(
	sim: rpc.Api.SimulateTransactionErrorResponse,
): ErrorEvent[] {
	return sim.events.flatMap((event) => {
		const [first, second] = event.event.body.v0.topics;
		const data = event.event.body.v0.data;
		if (
			event.event.type.name !== "diagnostic" ||
			symbol(first) !== "error" ||
			second?.type !== "scvError"
		) {
			return [];
		}
		return [
			{
				contract: emitter(event),
				error: second.error,
				values: data.type === "scvVec" ? (data.vec ?? []) : [data],
			},
		];
	});
}

/**
 * The error the result reports, at the start of `error`, with its type and
 * code: `Error(Contract, #4)`, "Contract", "#4".
 */
function primaryError(
	sim: rpc.Api.SimulateTransactionErrorResponse,
): [string | undefined, string | undefined, string | undefined] {
	const [, error, type, code] =
		/^HostError: (Error\(([A-Za-z]+), (#[0-9]+|[A-Za-z]+)\))/.exec(sim.error) ??
		[];
	return [error, type, code];
}

/**
 * Whether an error is one of the two a contract's own refusal can raise,
 * which only the diagnostic events can attribute (see
 * `classifySimulationFailure`).
 */
function refusalShaped(
	type: string | undefined,
	code: string | undefined,
): boolean {
	return (
		(type === "Contract" && code?.startsWith("#") === true) ||
		(type === "WasmVm" && code === "InvalidAction")
	);
}

/** The first string an error event carried: its message. */
function message(event: ErrorEvent): string | undefined {
	const text = event.values.find((value) => value.type === "scvString");
	return text?.type === "scvString" ? String(text.str) : undefined;
}

/**
 * Classify a failed simulation from its primary error and the diagnostic
 * events that carry it.
 *
 * The primary error is the one the result reports, at the start of
 * `error`. The invoked contract refused only when the events show that it,
 * and nothing else, raised that error: every `error` event carrying it came
 * from the invoked contract, and at least one did. The order of events
 * cannot settle it: a token passing on a called contract's `#4` and a
 * token that recovered from it and then raised its own `#4` can both show
 * that code from both contracts, so neither is credited.
 *
 * - `Error(Contract, #n)`: credited under that rule. With no event carrying
 *   it, nothing says who raised it, so it is not credited.
 * - `Error(WasmVm, InvalidAction)`: credited only when the invoked method
 *   itself trapped in the invoked contract, and no other contract's VM
 *   failed. The same error covers a module that failed to load or
 *   translate, before any method ran.
 * - Anything else, including no recognisable error at all: not credited.
 *
 * This rests on the host recording an `error` event in the contract whose
 * code raised an error, which it does in diagnostic mode. An RPC can
 * simulate without it (stellar-rpc's `preflight-enable-debug`), and then
 * nothing shows who raised an error, so no refusal is credited
 * (`describeSimulationFailure` says so in the evidence).
 */
export function classifySimulationFailure(
	sim: rpc.Api.SimulateTransactionErrorResponse,
): SimulationFailure {
	const [error, type, code] = primaryError(sim);
	const call = invokedCall(sim);
	if (error === undefined || call === undefined) {
		return { byContract: false, error };
	}
	const events = errorEvents(sim);
	if (type === "Contract" && code?.startsWith("#") === true) {
		const carrying = events.filter(
			(event) =>
				event.error.type === "sceContract" &&
				`#${event.error.contractCode}` === code,
		);
		const own =
			carrying.length > 0 &&
			carrying.every((event) => event.contract === call.contract);
		return own
			? {
					byContract: true,
					error,
					reason: carrying.map(message).find((text) => text !== undefined),
				}
			: { byContract: false, error };
	}
	if (type === "WasmVm" && code === "InvalidAction") {
		const vmErrors = events.filter(
			(
				event,
			): event is ErrorEvent & {
				error: Extract<ScError, { type: "sceWasmVm" }>;
			} => event.error.type === "sceWasmVm",
		);
		// A trap in another contract counts as a failure elsewhere, below.
		const trapped = vmErrors.some(
			(event) =>
				event.error.code.name === "scecInvalidAction" &&
				event.values[0]?.type === "scvString" &&
				String(event.values[0].str) === METHOD_TRAP &&
				symbol(event.values[1]) === call.method,
		);
		// Any VM error in another contract, whatever its code: the call may
		// have recovered from it, and the trace cannot say it did not matter.
		const elsewhere = vmErrors.some(
			(event) => event.contract !== call.contract,
		);
		if (trapped && !elsewhere) {
			return { byContract: true, error, reason: METHOD_TRAP };
		}
	}
	return { byContract: false, error };
}

/**
 * A failed simulation as readable evidence: the primary error, then the
 * diagnostic events in the order they were emitted.
 *
 * The RPC's `error` carries the primary error alone. Why the call failed
 * (a Stellar Asset Contract's "trustline entry is missing for account", a
 * panic's message, the method that trapped) is only in the events, so they
 * are rendered here for the person reading the evidence. No check reads
 * this text: verdicts come from `classifySimulationFailure` and its
 * `reason`.
 *
 * An error a contract's refusal could raise, with no diagnostic event
 * naming the call, ends with why it cannot be attributed and what would
 * attribute it.
 */
export function describeSimulationFailure(
	sim: rpc.Api.SimulateTransactionErrorResponse,
): string {
	const [error, type, code] = primaryError(sim);
	const unattributable =
		refusalShaped(type, code) && invokedCall(sim) === undefined
			? `\n\nThe RPC returned no diagnostic event naming the call, so whether the contract itself raised ${error} cannot be established. An RPC that returns simulation diagnostics (stellar-rpc with preflight-enable-debug) can attribute it.`
			: "";
	if (sim.events.length === 0) {
		return `${sim.error}${unattributable}`;
	}
	const lines = sim.events.map(
		({ event }, index) =>
			`   ${index}: [Diagnostic Event] ${
				event.contractId === null
					? ""
					: `contract:${contract(String(event.contractId))}, `
			}topics:[${event.body.v0.topics.map(render).join(", ")}], data:${render(event.body.v0.data)}`,
	);
	return `${sim.error}\n\nEvent log (oldest first):\n${lines.join("\n")}${unattributable}`;
}

/** A contract id from its hex, as a `C…` address where it can be encoded. */
function contract(hex: string): string {
	try {
		const bytes = Uint8Array.from(hex.match(/../g) ?? [], (pair) =>
			Number.parseInt(pair, 16),
		);
		return StrKey.encodeContract(
			bytes as Parameters<typeof StrKey.encodeContract>[0],
		);
	} catch {
		return hex;
	}
}

/** One event value, readably. Never throws: evidence must always render. */
function render(value: Value): string {
	if (value.type === "scvError") {
		const error = value.error;
		return error.type === "sceContract"
			? `Error(Contract, #${error.contractCode})`
			: `Error(${error.type.slice(3)}, ${error.code.name.slice(4)})`;
	}
	if (value.type === "scvSymbol") return String(value.sym);
	if (value.type === "scvString") return JSON.stringify(String(value.str));
	if (value.type === "scvBytes") return String(value.bytes);
	if (value.type === "scvVec") {
		return `[${(value.vec ?? []).map(render).join(", ")}]`;
	}
	try {
		const native: unknown = scValToNative(
			value as Parameters<typeof scValToNative>[0],
		);
		return typeof native === "bigint" || typeof native === "string"
			? String(native)
			: JSON.stringify(native, (_key, inner: unknown) =>
					typeof inner === "bigint" ? String(inner) : inner,
				);
	} catch {
		return value.type;
	}
}
