import {
	type Account,
	Address,
	BASE_FEE,
	nativeToScVal,
	Operation,
	rpc,
	scValToNative,
	TransactionBuilder,
	type xdr,
} from "@stellar/stellar-sdk";
import {
	AssembledTransaction,
	type Signer,
} from "@stellar/stellar-sdk/contract";

/**
 * Read path: simulate a contract call, decode the outcome.
 *
 * A trap is a result, not an exception — `interpretSimulation` maps it to
 * `{ kind: "trapped" }` so negative checks can assert on it. Only harness
 * failures (RPC down, malformed address) throw, and those propagate.
 */

// Transaction validity window. Irrelevant for pure simulation; kept so the
// write path builds identical transactions when it submits for real.
const TX_TIMEOUT_S = 30;

/**
 * Upper bound on any single RPC request, in milliseconds.
 *
 * Without one, an RPC that accepts the connection and never answers holds
 * a run forever (the SDK applies `timeout` only since 17.3, and has no
 * default). Thirty seconds is far above a healthy testnet round trip, so
 * it only ever cuts off a request that was not going to answer. Every
 * `rpc.Server` the tool creates takes it, and writes reuse that server.
 */
export const RPC_TIMEOUT_MS = 30_000;

/**
 * How long a written transaction stays valid, in seconds: the window a
 * wallet user has to approve it, and the point after which a transaction
 * the network never included is known not to have applied.
 */
const WRITE_VALIDITY_S = 180;

/** How often a sent transaction is looked up while waiting for its outcome. */
const POLL_INTERVAL_MS = 2_000;

/** Polling knobs, overridable so tests do not wait in real time. */
export interface WriteTiming {
	readonly pollIntervalMs?: number;
	readonly giveUpAfterMs?: number;
}

/** Lowercase hex, as the network writes transaction hashes. Works in the browser too, where Node's Buffer does not exist. */
function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

/** A single read-only contract invocation. Args arrive pre-encoded as ScVals. */
export interface ReadCall {
	readonly contractId: string;
	readonly method: string;
	readonly args: readonly xdr.ScVal[];
}

export type InvokeResult =
	/**
	 * `type` is the ScVal type the contract actually returned. The decoded
	 * value alone cannot be trusted for conformance: `i32 7` and `u32 7`
	 * both decode to the number 7, `Symbol` and `String` to the same
	 * string, `u64` and `i128` to the same bigint.
	 */
	| {
			readonly kind: "ok";
			readonly value: unknown;
			readonly type: xdr.ScVal["type"];
	  }
	/** A returned ScVal exists, but the SDK cannot represent it natively. */
	| {
			readonly kind: "undecodable";
			readonly type: xdr.ScVal["type"];
			readonly diagnostics: string;
	  }
	| { readonly kind: "trapped"; readonly diagnostics: string }
	| { readonly kind: "restore"; readonly diagnostics: string }
	| { readonly kind: "inconclusive"; readonly diagnostics: string };

/**
 * Outcome of a submitted call. Distinct from `InvokeResult` because a write
 * either reached the ledger or it did not, and the difference is evidence:
 * `applied` carries the transaction hash and ledger a reviewer can look up
 * long after the events age out of RPC.
 *
 * `rejected` is the contract refusing — a verdict. `timeout` is us giving
 * up watching, which is not: the transaction may yet apply, so callers must
 * map it to UNVERIFIABLE rather than FAIL.
 */
export type SubmitResult =
	| {
			readonly kind: "applied";
			readonly txHash: string;
			readonly ledger: number;
	  }
	| {
			readonly kind: "rejected";
			readonly diagnostics: string;
			/**
			 * True when the refusal is a transaction that reached the ledger
			 * and failed there, rather than a simulation the contract
			 * refused.
			 *
			 * The two are one `kind` because positive checks treat them
			 * alike — a contract that cannot complete a valid call is
			 * non-conformant however the refusal arrived. The negative
			 * check inverts that mapping, so for it the difference is the
			 * whole verdict: a contract refusing an unauthorized spend is
			 * the PASS, while a transaction dying on-chain for a fee, a
			 * sequence number or an expired footprint says nothing about
			 * authorization and must report UNVERIFIABLE.
			 *
			 * A flag rather than a message match: the wording is produced
			 * here, and a caller sniffing it would break the moment it is
			 * reworded.
			 */
			readonly settled: boolean;
			/**
			 * The transaction, when one reached the ledger to be looked up.
			 *
			 * Only a `settled` rejection has one: a refusal thrown at
			 * simulation never became a transaction. Carried as a field
			 * rather than left inside the diagnostics sentence, so a report
			 * can put it where a reader chases hashes instead of leaving it
			 * to be parsed out of prose.
			 */
			readonly txHash?: string;
			/** Ledger the failed transaction was included in, when known. */
			readonly ledger?: number;
	  }
	| { readonly kind: "restore"; readonly diagnostics: string }
	| { readonly kind: "timeout"; readonly txHash: string };

/**
 * Encode a `C...`/`G...` address argument. Contract functions take ScVals,
 * never raw strings — a raw string encodes as an ScString and the call traps
 * on type mismatch.
 */
export function addressArg(address: string): xdr.ScVal {
	return Address.fromString(address).toScVal();
}

/**
 * Encode an amount argument. SEP-41 amounts are `i128`, which exceeds the
 * range JavaScript numbers represent exactly — so the input is `bigint` and
 * the width is stated rather than inferred. A bare number would encode as
 * 64-bit and the call would trap on type mismatch.
 */
export function amountArg(amount: bigint): xdr.ScVal {
	return nativeToScVal(amount, { type: "i128" });
}

/**
 * The largest amount `amountArg` can encode.
 *
 * Stated beside the encoder that enforces it rather than in the one check
 * that needs it: a caller computing an amount from ledger state has to know
 * where the encoder stops, and a second copy elsewhere is a second thing to
 * keep true. `nativeToScVal` throws above this, which would escape a check
 * as SKIPPED rather than as the honest "this cannot be tested".
 */
export const I128_MAX = 2n ** 127n - 1n;

/**
 * Encode a ledger-sequence argument. `approve` takes its expiration as a
 * `u32`, not the `i128` amounts use — passing an amount-encoded value there
 * traps on type mismatch, so the two encoders stay separate rather than
 * inferring a width from the number.
 */
export function ledgerArg(ledger: number): xdr.ScVal {
	if (!Number.isInteger(ledger) || ledger < 0 || ledger > 0xff_ff_ff_ff) {
		throw new RangeError(`ledger sequence out of u32 range: ${ledger}`);
	}
	return nativeToScVal(ledger, { type: "u32" });
}

/**
 * I/O half: build the invocation against `source` and simulate it. Returns
 * the raw simulation response — decoding is `interpretSimulation`'s job.
 *
 * `source` supplies the sequence number only; simulation spends nothing.
 * Re-fetch it before each real transaction — sequence is consumed even by
 * transactions that fail on-chain.
 */
export async function simulateRead(
	server: rpc.Server,
	source: Account,
	call: ReadCall,
	// Required, not defaulted. The passphrase is network identity, and a
	// default lets a caller that forgets it simulate against testnet while
	// the run reports another network — a wrong answer that nothing makes
	// loud. Every caller already passes it.
	networkPassphrase: string,
): Promise<rpc.Api.SimulateTransactionResponse> {
	const tx = new TransactionBuilder(source, {
		fee: BASE_FEE,
		networkPassphrase,
	})
		.addOperation(
			Operation.invokeContractFunction({
				contract: call.contractId,
				function: call.method,
				args: [...call.args],
			}),
		)
		.setTimeout(TX_TIMEOUT_S)
		.build();
	return server.simulateTransaction(tx);
}

/**
 * Pure half: map a simulation response to an `InvokeResult`. No I/O, fully
 * unit-testable against captured fixtures.
 *
 * Decoding notes: integers wider than 32 bits arrive as `bigint` (i128
 * balances included) — never coerce to `number`. A `void` return decodes to
 * `null` (there is no other null source). Restore responses are
 * success-shaped at runtime and carry the answer — reads decode it as `ok`
 * because reads never submit; only a restore *without* an answer reports
 * `restore`. Answerless success is partial RPC data, never a contract trap,
 * so it reports `inconclusive` and callers must not FAIL on it.
 * A native conversion failure preserves the returned XDR type: a suite
 * can reject an unexpected type without mistaking an SDK limitation on
 * the expected type for a contract defect.
 */
export function interpretSimulation(
	sim: rpc.Api.SimulateTransactionResponse,
): InvokeResult {
	if (rpc.Api.isSimulationError(sim)) {
		return { kind: "trapped", diagnostics: sim.error };
	}
	if (rpc.Api.isSimulationSuccess(sim) && sim.result?.retval !== undefined) {
		const returned = sim.result.retval;
		try {
			return {
				kind: "ok",
				value: scValToNative(returned),
				type: returned.type,
			};
		} catch (error) {
			// Only conversion is guarded: RPC failures must still reach the
			// runner as harness errors. The raw type lets a check distinguish
			// a wrong return type from a decoder failing on the expected one.
			return {
				kind: "undecodable",
				type: returned.type,
				diagnostics: error instanceof Error ? error.message : String(error),
			};
		}
	}
	if (rpc.Api.isSimulationRestore(sim)) {
		return {
			kind: "restore",
			diagnostics:
				"no answer and archived entries need restoration before this call can execute",
		};
	}
	return {
		kind: "inconclusive",
		diagnostics: "simulation succeeded without a return value",
	};
}

export interface WriteCall extends ReadCall {
	/** Signs the transaction and any auth entry the contract demands. */
	readonly signer: Signer;
}

/**
 * Whether a thrown message reports something the contract did, as opposed to
 * something that stopped us reaching it.
 *
 * The distinction decides whether a caller may FAIL: a simulation that ran
 * and came back refused is evidence about the contract; a connection error
 * is evidence about us. Matched on the SDK's own wording for a completed
 * simulation, and conservative — an unrecognised message is
 * treated as a harness failure, which costs a SKIPPED (exit 2, "unknown")
 * rather than a false accusation.
 */
export function isContractOutcome(message: string): boolean {
	return /simulation failed|HostError|Error\(Contract/i.test(message);
}

/**
 * Submit a call and wait for the ledger to settle it.
 *
 * `AssembledTransaction` owns the whole sequence — simulate, assemble the
 * footprint and fee, sign the envelope, sign whatever auth entries the
 * contract demanded, submit, poll. Hand-rolling it would duplicate the
 * SDK's own retry and restore handling for no gain.
 *
 * A write costs a ledger close (~4-5s observed on testnet), so a suite of
 * them runs in minutes, not milliseconds.
 *
 * Refusals are returned, not thrown: a contract rejecting a transfer is
 * exactly what a negative check asserts. Harness failures — anything that
 * stopped us reaching the ledger — genuinely do propagate, so the runner
 * can record SKIPPED rather than a verdict we never earned.
 */
export async function submitWrite(
	server: rpc.Server,
	call: WriteCall,
	networkPassphrase: string,
	timing: WriteTiming = {},
): Promise<SubmitResult> {
	// Three phases, because what an error means depends on where it
	// happened. Before sending, nothing has left this process: a contract
	// refusal is a verdict and anything else is a harness failure. Once
	// sent, nothing that goes wrong is the contract refusing — the only
	// question is whether the transaction applied, and when that cannot be
	// established the outcome is unknown.
	let assembled: AssembledTransaction<xdr.ScVal>;
	try {
		assembled = await AssembledTransaction.build({
			contractId: call.contractId,
			method: call.method,
			args: [...call.args],
			rpcUrl: server.serverURL.toString(),
			// The caller's server, not one rebuilt from the URL: it carries
			// the request timeout (RPC_TIMEOUT_MS), which a fresh client
			// would not.
			server,
			// The read server was built with the operator's --allow-http
			// consent; deriving the same permission from the same URL keeps
			// the write client from dropping it. Without this, local-node
			// runs read fine and every write SKIPs on the SDK's insecure
			// endpoint refusal.
			allowHttp: server.serverURL.protocol === "http:",
			networkPassphrase,
			publicKey: call.signer.address,
			signTransaction: call.signer,
			parseResultXdr: (value: xdr.ScVal) => value,
			// A bounded validity window is what lets a lost answer become a
			// known one: once the network's ledger time passes it, a
			// transaction not found can never apply. Long enough for a
			// person to approve it in a wallet.
			timeoutInSeconds: WRITE_VALIDITY_S,
		});
		// `build` simulates without throwing; `sign` reads that simulation
		// and is where a contract's refusal (SimulationFailed) or archived
		// state (ExpiredState) surfaces.
		await assembled.sign();
	} catch (error) {
		// Detected by class, not by message: the SDK exports this error type,
		// so no wording can drift out from under it. A read reports the same
		// situation as `restore`, and a write must not call it a refusal.
		if (error instanceof AssembledTransaction.Errors.ExpiredState) {
			return { kind: "restore", diagnostics: error.message };
		}
		const message = error instanceof Error ? error.message : String(error);
		if (!isContractOutcome(message)) {
			throw error;
		}
		// Refused before anything was sent: a simulation the contract refused.
		return { kind: "rejected", diagnostics: message, settled: false };
	}
	const signed = assembled.signed;
	if (signed === undefined) {
		throw new Error("signing produced no transaction to send");
	}
	// The hash of what was signed is the transaction's identity, known
	// before anything leaves: the only handle on a send whose answer never
	// arrives.
	const txHash = toHex(signed.hash());
	const validUntil = Number(signed.timeBounds?.maxTime ?? 0);
	const validFrom = Number(signed.timeBounds?.minTime ?? 0);
	const simulationLedger = assembled.simulation?.latestLedger;

	let sent: Awaited<ReturnType<rpc.Server["sendTransaction"]>>;
	try {
		sent = await server.sendTransaction(signed);
	} catch {
		// The request failed, but it may have reached the network first.
		return { kind: "timeout", txHash };
	}
	// ERROR and TRY_AGAIN_LATER are the network declining the transaction:
	// it was not accepted and cannot apply, so this is a known outcome and
	// a harness failure, not a verdict. DUPLICATE means it already has it,
	// so it is followed like PENDING. Read from the typed status rather
	// than from an SDK error message.
	if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
		throw new Error(
			`the network did not accept transaction ${txHash} (${sent.status})`,
		);
	}

	const pollMs = timing.pollIntervalMs ?? POLL_INTERVAL_MS;
	const giveUpAt =
		Date.now() + (timing.giveUpAfterMs ?? (WRITE_VALIDITY_S + 60) * 1000);
	for (;;) {
		// Errors while polling are never the contract's answer, whatever
		// their text: a message that happens to contain "HostError" here
		// must not be read as a refusal a negative check could credit.
		const seen = await server.getTransaction(txHash).catch(() => undefined);
		if (seen?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
			return { kind: "applied", txHash, ledger: seen.ledger };
		}
		if (seen?.status === rpc.Api.GetTransactionStatus.FAILED) {
			// It reached the ledger and died there. Why is not recoverable
			// from this response, so it is not attributable to the contract:
			// see `settled` on SubmitResult.
			return {
				kind: "rejected",
				settled: true,
				txHash,
				...(seen.ledger === undefined ? {} : { ledger: seen.ledger }),
				diagnostics: `transaction ${txHash} failed on-chain`,
			};
		}
		// An expired envelope cannot apply in a future ledger. To establish
		// it did not apply earlier, the RPC must still cover its entire
		// possible inclusion window. For a fresh send, our pre-signing
		// simulation precedes that window. A duplicate may predate it and
		// needs an explicit lower time bound to prove absence.
		if (
			seen?.status === rpc.Api.GetTransactionStatus.NOT_FOUND &&
			validUntil > 0 &&
			Number(seen.latestLedgerCloseTime) > validUntil &&
			(validFrom > 0
				? Number(seen.oldestLedgerCloseTime) <= validFrom
				: sent.status === "PENDING" &&
					simulationLedger !== undefined &&
					seen.oldestLedger <= simulationLedger + 1)
		) {
			throw new Error(
				`transaction ${txHash} expired without being included in a ledger`,
			);
		}
		if (Date.now() >= giveUpAt) {
			// Still unanswered: we stopped watching, the network did not
			// necessarily refuse. The hash is the handle a human needs to
			// find out which it was.
			return { kind: "timeout", txHash };
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
