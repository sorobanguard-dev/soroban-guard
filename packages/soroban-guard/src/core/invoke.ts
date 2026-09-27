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
	SentTransaction,
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

/** A single read-only contract invocation. Args arrive pre-encoded as ScVals. */
export interface ReadCall {
	readonly contractId: string;
	readonly method: string;
	readonly args: readonly xdr.ScVal[];
}

export type InvokeResult =
	| { readonly kind: "ok"; readonly value: unknown }
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
 */
export function interpretSimulation(
	sim: rpc.Api.SimulateTransactionResponse,
): InvokeResult {
	if (rpc.Api.isSimulationError(sim)) {
		return { kind: "trapped", diagnostics: sim.error };
	}
	if (rpc.Api.isSimulationSuccess(sim) && sim.result?.retval !== undefined) {
		return { kind: "ok", value: scValToNative(sim.result.retval) };
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
): Promise<SubmitResult> {
	// Not every throw is a verdict: `signAndSend` re-simulates before
	// submitting, so a refusal surfaces there just as from `build`. Classify
	// the throw — see `isContractOutcome` — and let harness failures
	// propagate for the runner to record as SKIPPED.
	// The hash has to be captured as it is submitted, not read off the
	// result: when polling ends without the transaction appearing, the SDK
	// throws rather than returning, and the only object holding the hash
	// goes with it.
	let submittedHash = "";
	let sent: Awaited<ReturnType<AssembledTransaction<xdr.ScVal>["signAndSend"]>>;
	try {
		const assembled = await AssembledTransaction.build({
			contractId: call.contractId,
			method: call.method,
			args: [...call.args],
			rpcUrl: server.serverURL.toString(),
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
		});
		sent = await assembled.signAndSend({
			watcher: {
				onSubmitted: (response) => {
					submittedHash = response?.hash ?? "";
				},
			},
		});
	} catch (error) {
		// Polling gave up while the transaction was still pending. It may yet
		// apply, so this is not a verdict — and the hash is the one thing a
		// reader needs to find out which way it went. Detected by class: the
		// message is a JSON dump that no classifier should be parsing.
		if (error instanceof SentTransaction.Errors.TransactionStillPending) {
			return { kind: "timeout", txHash: submittedHash };
		}
		// Detected by class, not by message: the SDK exports this error type,
		// so no wording can drift out from under it. A read reports the same
		// situation as `restore`, and a write must not call it a refusal.
		if (error instanceof AssembledTransaction.Errors.ExpiredState) {
			return {
				kind: "restore",
				diagnostics: error.message,
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		if (!isContractOutcome(message)) {
			throw error;
		}
		// Thrown before the ledger saw it: a simulation the contract refused.
		return { kind: "rejected", diagnostics: message, settled: false };
	}
	const settled = sent.getTransactionResponse;
	const txHash = sent.sendTransactionResponse?.hash ?? "";
	if (settled?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
		return { kind: "applied", txHash, ledger: settled.ledger };
	}
	if (settled?.status === rpc.Api.GetTransactionStatus.FAILED) {
		// It reached the ledger and died there. Why is not recoverable from
		// this response, so it is not attributable to the contract: see
		// `settled` on SubmitResult.
		return {
			kind: "rejected",
			settled: true,
			...(txHash === "" ? {} : { txHash }),
			...(settled.ledger === undefined ? {} : { ledger: settled.ledger }),
			diagnostics:
				txHash === ""
					? "transaction failed on-chain; no transaction hash was observed"
					: `transaction ${txHash} failed on-chain`,
		};
	}
	// Still NOT_FOUND after the SDK's polling window: we stopped watching,
	// the network did not necessarily refuse. The hash is the handle a human
	// needs to find out which it was.
	return { kind: "timeout", txHash };
}
