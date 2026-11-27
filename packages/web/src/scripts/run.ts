/**
 * Build a run context from what a browser can know, then hand it to the
 * same suite the CLI runs.
 *
 * Nothing about the checks is re-implemented here. `runSuite`,
 * `withCoverageGaps` and `exitCodeFor` are imported from the package that
 * the CLI uses, so a verdict rendered on this page and a verdict printed in
 * a terminal come from one implementation. The only thing that differs is
 * how the context is assembled: the CLI reads secrets from the environment,
 * and this asks a wallet.
 */
import {
	Asset,
	BASE_FEE,
	Keypair,
	Operation,
	rpc,
	StrKey,
	TransactionBuilder,
	xdr,
} from "@stellar/stellar-sdk";
import { KeypairSigner, type Signer } from "@stellar/stellar-sdk/contract";
import { fundAccountInLedger } from "soroban-guard/src/core/funding.ts";
import {
	addressArg,
	amountArg,
	declined,
	type HistoryProgress,
	type InclusionWindow,
	interpretSimulation,
	type Lookup,
	lookupOutcome,
	RPC_TIMEOUT_MS,
	type SubmitResult,
	sendAndFollow,
	simulateRead,
	staleAnswer,
	submitWrite,
} from "soroban-guard/src/core/invoke.ts";
import { exitCodeFor } from "soroban-guard/src/core/report.ts";
import { runSuite } from "soroban-guard/src/core/runner.ts";
import { inspectContract } from "soroban-guard/src/core/spec.ts";
import type { CheckResult } from "soroban-guard/src/core/types.ts";
import type { Party, Sep41Context } from "soroban-guard/src/sep41/context.ts";
import { sep41Suite, withCoverageGaps } from "soroban-guard/src/sep41/index.ts";
import { noteSettled } from "soroban-guard/src/sep41/write.ts";
import { isDemoContract } from "../data/demo.ts";
import { freighterSigner } from "./freighter.ts";

export interface RunRequest {
	readonly contractId: string;
	readonly rpcUrl: string;
	readonly networkPassphrase: string;
	/** The connected wallet, which signs as the holder. */
	readonly ownerAddress: string;
	/**
	 * A second address to receive transfers and hold allowances.
	 * When omitted, `spenderParty` supplies a separate account or address.
	 */
	readonly spenderAddress?: string;
	/**
	 * Who signs as the holder. The connected wallet when absent, which is
	 * every real use; supplying a key instead lets the exact browser path —
	 * throwaway spender, faucet, all sixteen checks — be exercised from a
	 * script, with nothing standing in for it but the popup.
	 */
	readonly ownerSigner?: Signer;
	/**
	 * The oldest ledger the run's simulations, and the balances and signers'
	 * sequence numbers it reads, must describe, because an earlier
	 * transaction may have moved them by then. The contract's code, read
	 * first, is not something a transaction of the page moves.
	 */
	readonly minLedger?: number;
}

/**
 * What a Stellar Asset Contract wraps, read from its own `name()`: the
 * classic asset for an issued token, `"native"` for XLM, `undefined` for a
 * custom WASM token or a name that is not in the SAC's `CODE:ISSUER` form.
 *
 * Needed because a classic asset can only be received by an account that
 * trusts it — the temporary spender cannot take a single unit until it has
 * a trustline, and the checks that send it one would all report the
 * asset's own refusal instead of the contract's behaviour.
 */
async function wrappedAsset(
	server: rpc.Server,
	request: RunRequest,
	source: Awaited<ReturnType<rpc.Server["getAccount"]>>,
	minLedger: number | undefined,
): Promise<Asset | "native" | undefined> {
	const simulation = await simulateRead(
		server,
		source,
		{
			contractId: request.contractId.trim(),
			method: "name",
			args: [],
			...(minLedger === undefined ? {} : { minLedger }),
		},
		request.networkPassphrase,
	);
	// An answer from before the floor is no answer about the asset: thrown,
	// so setup fails as it does on any read it cannot make.
	const stale = staleAnswer(simulation.latestLedger, minLedger);
	if (stale !== undefined) {
		throw new Error(`the asset contract's name() could not be read (${stale})`);
	}
	const outcome = interpretSimulation(simulation);
	if (outcome.kind !== "ok" || typeof outcome.value !== "string") {
		return undefined;
	}
	if (outcome.value === "native") {
		return "native";
	}
	const match = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(outcome.value);
	// The issuer is checksummed, not just shape-matched: a name that merely
	// looks like CODE:ISSUER would otherwise cost a pointless trustline.
	if (match === null || !StrKey.isValidEd25519PublicKey(match[2])) {
		return undefined;
	}
	return new Asset(match[1], match[2]);
}

/**
 * Give the temporary account a trustline, and wait for it to land. Returns
 * the ledger it landed in.
 */
async function addTrustline(
	server: rpc.Server,
	keypair: Keypair,
	asset: Asset,
	networkPassphrase: string,
): Promise<number> {
	const before = await server.getLatestLedger();
	const account = await server.getAccount(keypair.publicKey());
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase,
	})
		.addOperation(Operation.changeTrust({ asset }))
		.setTimeout(60)
		.build();
	tx.sign(keypair);
	const outcome = await sendAndFollow(server, tx, {
		ledger: before.sequence,
		transaction: tx,
	});
	const trustline = `the temporary account's trustline to ${asset.getCode()}`;
	switch (outcome.kind) {
		case "applied":
			return outcome.ledger;
		case "failed":
			throw new Error(`${trustline} failed on-chain`);
		case "not-accepted":
			throw new Error(`${trustline} was refused (${declined(outcome)})`);
		case "expired":
			throw new Error(`${trustline} expired without landing`);
		case "unknown":
			throw new Error(
				`${trustline} could not be confirmed; transaction ${outcome.txHash} may still apply`,
			);
	}
}

/** The second party the run supplies, with what the page needs to clean up. */
interface TemporarySpender {
	readonly party: Party;
	readonly keypair: Keypair;
	/**
	 * What an asset contract wraps (see `wrappedAsset`), `"unidentified"`
	 * when its `name()` could not say, and `undefined` for a custom token.
	 */
	readonly asset: Asset | "native" | "unidentified" | undefined;
}

/**
 * The second party, when the visitor did not name one: a temporary account
 * this page creates, funds and signs for, on any token.
 *
 * Four checks must be signed by the spender, and a browser wallet signs as
 * one party. Supplying a keyed second account is what lets one wallet get
 * all sixteen verdicts — the CLI gets the same by taking two keys. The
 * account's key lives only in this tab. It is marked as not throwaway
 * because the page does hold its key for the whole run. When the run ends
 * `returnUnits` tries to send whatever it received back to the holder. That
 * is best effort, not a guarantee: a token that refuses the transfer leaves
 * the few units a run moves in the temporary account, and the page says so.
 *
 * A named counterparty is used as given, without a signer: the page cannot
 * sign for an address it did not create, so those four checks then say
 * what they would need.
 */
export async function spenderParty(
	request: RunRequest,
	server: rpc.Server,
	source: Awaited<ReturnType<rpc.Server["getAccount"]>>,
	isAssetContract: boolean,
	onStage?: (text: string) => void,
): Promise<{
	party: Party;
	temporary?: TemporarySpender;
	setupFailed?: string;
	/** The latest ledger the setup's own transactions landed in, when known. */
	settledThrough?: number;
}> {
	const named = request.spenderAddress?.trim();
	if (named !== undefined && named !== "") {
		return { party: { address: named, isThrowaway: false } };
	}
	const keypair = Keypair.random();
	try {
		onStage?.("Creating a temporary second account to sign as the spender…");
		const setup: Sep41Context["soundness"] = {};
		noteSettled(setup, await fundAccountInLedger(server, keypair.publicKey()));
		// Only a Stellar Asset Contract wraps a classic asset. A custom
		// token's name is whatever its author chose, and one that happens to
		// read CODE:ISSUER must not buy a trustline it does not need.
		const floor = Math.max(request.minLedger ?? 0, setup.settledThrough ?? 0);
		const asset = isAssetContract
			? ((await wrappedAsset(
					server,
					request,
					source,
					floor === 0 ? undefined : floor,
				)) ?? "unidentified")
			: undefined;
		if (asset instanceof Asset) {
			onStage?.(
				`Giving the temporary account a trustline to ${asset.getCode()}…`,
			);
			noteSettled(
				setup,
				await addTrustline(server, keypair, asset, request.networkPassphrase),
			);
		}
		const party: Party = {
			address: keypair.publicKey(),
			signer: new KeypairSigner(keypair, request.networkPassphrase),
			isThrowaway: false,
		};
		return {
			party,
			temporary: { party, keypair, asset },
			...(setup.settledThrough === undefined
				? {}
				: { settledThrough: setup.settledThrough }),
		};
	} catch (error) {
		// Setup trouble (Friendbot down, a trustline refused) must cost the
		// checks that need a usable second account, not the whole run. Fall
		// back to a keyless generated address the suite already knows how to
		// report on: the reads and the holder's other writes still run.
		//
		// A fresh address, not the setup's account: a funding or trustline
		// transaction that may still land could change that account between
		// the approvals and reads that name the spender. Like the CLI's
		// generated spender, this one has never been used.
		return {
			party: { address: Keypair.random().publicKey(), isThrowaway: true },
			setupFailed: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Send what the temporary account received back to the holder.
 *
 * Best effort, and reported rather than thrown: the verdicts are already
 * in, and a token broken enough to refuse this transfer — the vulnerable
 * fixture leaves a balance that reads negative — must not turn a finished
 * run into an error. Not called for XLM (see `runChecks`).
 *
 * The balance, and the transfer's simulation, must describe state from
 * the latest ledger a transaction of this run settled in, and the
 * transfer, once it reaches a ledger, is noted as the latest.
 */
async function returnUnits(
	server: rpc.Server,
	request: RunRequest,
	temporary: TemporarySpender,
	soundness: Sep41Context["soundness"],
): Promise<
	| { returned: bigint }
	| { failed: string; retryable: boolean }
	| { pending: { transfer: Unresolved; amount: bigint } }
> {
	try {
		const source = await server.getAccount(temporary.party.address);
		const minLedger = soundness.settledThrough;
		const fresh = minLedger === undefined ? {} : { minLedger };
		const simulation = await simulateRead(
			server,
			source,
			{
				contractId: request.contractId.trim(),
				method: "balance",
				args: [addressArg(temporary.party.address)],
				...fresh,
			},
			request.networkPassphrase,
		);
		// A balance from before a transaction this run saw settle says
		// nothing about what the account holds now: zero there could leave
		// units credited since, so the cleanup stays retryable with the key.
		const stale = staleAnswer(simulation.latestLedger, minLedger);
		if (stale !== undefined) {
			return {
				failed: `the temporary account's balance could not be read (${stale})`,
				retryable: true,
			};
		}
		const read = interpretSimulation(simulation);
		// An unreadable balance is not an empty one: reporting it as "0
		// returned" would say the cleanup finished while units may still be
		// sitting in the temporary account.
		if (read.kind !== "ok" || typeof read.value !== "bigint") {
			return {
				failed:
					read.kind === "ok"
						? "the token's balance() did not return a number for the temporary account"
						: `the temporary account's balance could not be read (${read.diagnostics})`,
				// Usually a passing RPC problem; reading again may succeed.
				retryable: true,
			};
		}
		const held = read.value;
		// A negative balance is invalid token accounting, not an empty
		// account: returning "no units" for it would report a finished
		// cleanup over money that should not exist.
		if (held < 0n) {
			return {
				failed: `the token reports a balance of ${held} for the temporary account`,
				// Impossible accounting: no retry can return units the token
				// itself says do not exist.
				retryable: false,
			};
		}
		if (held <= 0n || temporary.party.signer === undefined) {
			return { returned: 0n };
		}
		const sent = await submitWrite(
			server,
			{
				contractId: request.contractId.trim(),
				method: "transfer",
				args: [
					addressArg(temporary.party.address),
					addressArg(request.ownerAddress),
					amountArg(held),
				],
				signer: temporary.party.signer,
				...fresh,
			},
			request.networkPassphrase,
		);
		if (sent.kind === "applied" || sent.kind === "rejected") {
			noteSettled(soundness, sent.ledger);
		}
		if (sent.kind === "timeout") {
			return { pending: { transfer: unresolvedFrom(sent), amount: held } };
		}
		return sent.kind === "applied"
			? { returned: held }
			: {
					failed: `the transfer back was not applied (${sent.kind})`,
					retryable: true,
				};
	} catch (error) {
		return {
			failed: error instanceof Error ? error.message : String(error),
			retryable: true,
		};
	}
}

/** Stroops in one XLM. */
export const STROOPS_PER_XLM = 10_000_000n;

/** The network's base reserve per ledger entry: 0.5 XLM. */
const BASE_RESERVE = 5_000_000n;

/**
 * The XLM the wallet can actually spend on fees: its balance above the
 * minimum reserve every account must hold.
 *
 * A wallet can show "1 XLM" and have none of it to spend — 1 XLM is exactly
 * the reserve of an account with no trustlines — and every write it signs
 * then comes back from the network as `tx_insufficient_balance`. Read before
 * a run so the page says so up front rather than reporting a check that did
 * not complete. Sponsorships move the reserve both ways and are counted;
 * liabilities are still ignored: a wallet sophisticated enough to have them
 * is not the one this protects.
 *
 * `null` when the account does not exist on the network yet — a wallet
 * created in Freighter but never funded — which the page answers with
 * Friendbot, not with a fee shortfall. Read with `getLedgerEntry` rather
 * than the SDK's `getAccountEntry`, which turns every failure, a dropped
 * connection included, into "Account not found": the same distinction
 * `accountExists` in the CLI's funding code draws, for the same reason.
 * Any other error propagates.
 */
export async function spendableXlm(
	rpcUrl: string,
	address: string,
): Promise<bigint | null> {
	const key = xdr.LedgerKey.account(
		new xdr.LedgerKeyAccount({
			accountId: Keypair.fromPublicKey(address).xdrPublicKey(),
		}),
	);
	let found: Awaited<ReturnType<rpc.Server["getLedgerEntry"]>>;
	try {
		found = await new rpc.Server(rpcUrl, {
			timeout: RPC_TIMEOUT_MS,
		}).getLedgerEntry(key);
	} catch (error) {
		if (
			error instanceof Error &&
			/failed to find an entry/i.test(error.message)
		) {
			return null;
		}
		throw error;
	}
	if (found.val.type !== "account") {
		throw new Error(`expected an account entry for ${address}`);
	}
	// Plain fields in SDK 17's generated XDR, not accessor methods.
	const entry = found.val.value;
	// Sponsorships move the reserve both ways: entries others sponsor for
	// this account still count, entries it sponsors elsewhere do not. A
	// sponsored wallet can therefore spend below the naive two-reserve
	// floor, and ignoring the counters would block it from running at all.
	// Absent extension data means no sponsorships, not zero information.
	const { numSponsoring, numSponsored } = sponsorship(entry);
	const reserve =
		(2n +
			BigInt(entry.numSubEntries) +
			BigInt(numSponsoring) -
			BigInt(numSponsored)) *
		BASE_RESERVE;
	return entry.balance - reserve;
}

/**
 * How many reserves this account sponsors elsewhere, and how many of its
 * own are sponsored — both zero when the ledger entry carries no extension
 * data at all.
 */
export function sponsorship(entry: xdr.AccountEntry): {
	numSponsoring: number;
	numSponsored: number;
} {
	const none = { numSponsoring: 0, numSponsored: 0 };
	const ext = entry.ext;
	if (ext.type !== "v1") {
		return none;
	}
	const inner = ext.v1.ext;
	if (inner.type !== "v2") {
		return none;
	}
	return {
		numSponsoring: inner.v2.numSponsoring,
		numSponsored: inner.v2.numSponsored,
	};
}

/**
 * The wallet's balance of the token, read before any write is attempted.
 *
 * `undefined` when the balance could not be read at all — a contract that
 * traps on `balance`, say. That is the suite's to judge, so the page then
 * runs rather than guessing. So is a balance only an RPC behind
 * `request.minLedger` would give.
 */
export async function tokenBalance(
	request: Pick<
		RunRequest,
		"rpcUrl" | "networkPassphrase" | "contractId" | "minLedger"
	>,
	address: string,
): Promise<bigint | undefined> {
	const server = new rpc.Server(request.rpcUrl, { timeout: RPC_TIMEOUT_MS });
	const source = await server.getAccount(address);
	const simulation = await simulateRead(
		server,
		source,
		{
			contractId: request.contractId.trim(),
			method: "balance",
			args: [addressArg(address)],
			...(request.minLedger === undefined
				? {}
				: { minLedger: request.minLedger }),
		},
		request.networkPassphrase,
	);
	if (staleAnswer(simulation.latestLedger, request.minLedger) !== undefined) {
		return undefined;
	}
	const outcome = interpretSimulation(simulation);
	return outcome.kind === "ok" && typeof outcome.value === "bigint"
		? outcome.value
		: undefined;
}

/**
 * Take five units from the demo token's faucet, signed in the wallet.
 *
 * The faucet needs no authorisation, but a transaction still needs a
 * source to pay its fee, and the visitor's wallet is the only account the
 * page can sign for before a run.
 */
export async function claimDemoTokens(
	request: Pick<
		RunRequest,
		"rpcUrl" | "networkPassphrase" | "contractId" | "minLedger"
	>,
	address: string,
	signer: Signer = freighterSigner(address, request.networkPassphrase),
): Promise<Settlement> {
	if (!isDemoContract(request.contractId)) {
		throw new Error("Test tokens are only available for the demo token.");
	}
	const server = new rpc.Server(request.rpcUrl, { timeout: RPC_TIMEOUT_MS });
	const outcome = await submitWrite(
		server,
		{
			contractId: request.contractId.trim(),
			method: "faucet",
			args: [addressArg(address)],
			signer,
			...(request.minLedger === undefined
				? {}
				: { minLedger: request.minLedger }),
		},
		request.networkPassphrase,
	);
	switch (outcome.kind) {
		case "applied":
			return { landed: outcome.ledger };
		case "timeout":
			return { unresolved: unresolvedFrom(outcome) };
		case "rejected":
			return outcome.ledger === undefined
				? { failed: outcome.diagnostics }
				: { failed: outcome.diagnostics, ledger: outcome.ledger };
		case "restore":
			return { failed: outcome.diagnostics };
	}
}

/**
 * What a transaction the page sent came to: the ledger it landed in; why it
 * did not go through, with the ledger it failed in when it reached one; or,
 * when it was sent and not confirmed while it was followed, the
 * transaction to look up again with `transactionStatus`, since it may
 * still land.
 */
export type Settlement =
	| { readonly landed: number }
	| { readonly failed: string; readonly ledger?: number }
	| { readonly unresolved: Unresolved };

/** Look up again a transaction that was not confirmed (see `lookupOutcome`). */
export async function transactionStatus(
	request: Pick<RunRequest, "rpcUrl">,
	open: Unresolved,
): Promise<Settlement> {
	const server = new rpc.Server(request.rpcUrl, { timeout: RPC_TIMEOUT_MS });
	const seen = await lookupOutcome(
		server,
		open.txHash,
		open.window,
		undefined,
		open.progress,
	);
	switch (seen.kind) {
		case "applied":
			return { landed: seen.ledger };
		case "failed":
			return seen.ledger === undefined
				? { failed: "it failed on the ledger" }
				: { failed: "it failed on the ledger", ledger: seen.ledger };
		case "expired":
			return { failed: "it expired without landing" };
		case "pending":
			return { unresolved: goneOn(open, seen) };
	}
}

/**
 * A write the follow gave up on, as the page waits on it: everything the
 * follow learned, the ledger it saw close past the deadline included.
 */
function unresolvedFrom(
	sent: Extract<SubmitResult, { kind: "timeout" }>,
): Unresolved {
	return {
		txHash: sent.txHash,
		...(sent.window === undefined ? {} : { window: sent.window }),
		...(sent.progress === undefined ? {} : { progress: sent.progress }),
		...(sent.closedAfterDeadline === undefined
			? {}
			: { closedAfterDeadline: sent.closedAfterDeadline }),
	};
}

/**
 * `unresolved` after a lookup that left it open, with how far that lookup
 * read the history and the ledger it saw close after the deadline. What an
 * earlier lookup established stays: a later one that fails says nothing
 * against it.
 */
function goneOn(
	unresolved: Unresolved,
	seen: Extract<Lookup, { kind: "pending" }>,
): Unresolved {
	return {
		...unresolved,
		...(seen.progress === undefined ? {} : { progress: seen.progress }),
		...(seen.closedAfterDeadline === undefined
			? {}
			: { closedAfterDeadline: seen.closedAfterDeadline }),
	};
}

/**
 * What happened to the temporary account's units at the end of a run.
 * `retry`, when present, tries again with the same account — the only way
 * back to it, since its key lives nowhere but this tab.
 */
export type Cleanup = (
	| { readonly returned: bigint }
	| {
			readonly failed: string;
			/** The transaction this waits on, whose outcome is open. */
			readonly pendingTxHash?: string;
			/**
			 * A ledger the RPC reported closed after that transaction's
			 * deadline, once a status check has seen one. The transaction
			 * can no longer apply, so state from this ledger on holds it
			 * either way; whether it did is still open, and `retry` sends
			 * nothing until that is known.
			 */
			readonly closedAfterDeadline?: number;
			readonly retry?: () => Promise<Cleanup>;
	  }
) & {
	/**
	 * The latest ledger a transaction of the run, the send-back included,
	 * was known to have settled in when this was reported.
	 */
	readonly settledThrough?: number;
};

/**
 * A sent transaction whose outcome is still open: its hash, the window a
 * lookup can prove it expired from, how far the history was read, and
 * `closedAfterDeadline` (see `Cleanup`).
 */
export interface Unresolved {
	readonly txHash: string;
	readonly window?: InclusionWindow;
	readonly progress?: HistoryProgress;
	readonly closedAfterDeadline?: number;
}

/**
 * Keep the temporary signer reachable while retrying only the lookup.
 * `onSettled(false)` means the transaction is known not to have applied
 * (it failed on-chain, or provably expired unincluded), so sending again
 * is safe; while it may still apply, the page keeps waiting. Each status
 * check goes on with the history where the one before stopped.
 *
 * A transaction that settled is noted in `soundness` first: the balance
 * read and send-back that may follow must not describe state from before
 * it. A lookup that leaves it open goes on as `goneOn` says.
 */
function waitForCleanupReceipt(
	server: rpc.Server,
	soundness: Sep41Context["soundness"],
	unresolved: Unresolved,
	failed: string,
	onSettled: (succeeded: boolean) => Promise<Cleanup>,
): Cleanup {
	const { txHash, window, progress, closedAfterDeadline } = unresolved;
	if (txHash === "") return { failed };
	return {
		failed:
			closedAfterDeadline === undefined
				? `${failed}. Transaction ${txHash} may still apply.`
				: `${failed}. Transaction ${txHash} can no longer apply: ledger ${closedAfterDeadline} closed after its deadline. Whether it applied before then is not yet known.`,
		pendingTxHash: txHash,
		...(closedAfterDeadline === undefined ? {} : { closedAfterDeadline }),
		async retry() {
			const seen = await lookupOutcome(
				server,
				txHash,
				window,
				undefined,
				progress,
			);
			if (seen.kind === "pending") {
				return waitForCleanupReceipt(
					server,
					soundness,
					goneOn(unresolved, seen),
					failed,
					onSettled,
				);
			}
			if (seen.kind === "applied" || seen.kind === "failed") {
				noteSettled(soundness, seen.ledger);
			}
			return onSettled(seen.kind === "applied");
		},
	};
}

export interface RunOutcome {
	readonly results: readonly CheckResult[];
	readonly exitCode: number;
	/**
	 * When the run supplied its own second account: how many units went back
	 * to the holder at the end, or why they could not. Absent when the
	 * visitor named the counterparty.
	 */
	readonly cleanup?: Cleanup;
	/**
	 * The latest ledger a transaction of the run, the send-back included,
	 * settled in, when one did. A later run's reads must describe state
	 * from it or after.
	 */
	readonly settledThrough?: number;
	/**
	 * A write of the run whose outcome stayed unknown, when no cleanup waits
	 * on it: it may still land and move the wallet's balance, so the page
	 * holds the next run until `transactionStatus` settles it or finds it
	 * can no longer land. A cleanup that waits on it carries it instead.
	 */
	readonly unresolvedWrite?: Unresolved;
	/**
	 * Why the run could not set up its own second account, when it could
	 * not. The run went ahead without one: the four spender-signed checks
	 * then report what they would need.
	 */
	readonly spenderSetupFailed?: string;
}

/**
 * Whether a string is a contract id this run can use.
 *
 * Checked before any network call so a typo reports as a typo rather than
 * as an RPC failure ten seconds later — which is exactly why this uses the
 * SDK's strkey decoder rather than a shape regex. Strkey carries a CRC16,
 * so a single mistyped character is detectable here; `C` followed by 55
 * `A`s matches `/^C[A-Z2-7]{55}$/` and is not a contract id.
 *
 * Still says nothing about whether the contract exists. That is the run's
 * first real question.
 */
export function looksLikeContractId(value: string): boolean {
	return StrKey.isValidContract(value.trim());
}

/** Same rule for the G-addresses the parties use. */
export function looksLikeAccountId(value: string): boolean {
	return StrKey.isValidEd25519PublicKey(value.trim());
}

/**
 * Run the full suite against a contract, signing through the wallet.
 *
 * Each write waits for a ledger to close. `onProgress` reports completed
 * checks while the suite is running.
 */
export async function runChecks(
	request: RunRequest,
	onProgress?: (completed: number, total: number) => void,
	onStage?: (text: string) => void,
): Promise<RunOutcome> {
	const server = new rpc.Server(request.rpcUrl, { timeout: RPC_TIMEOUT_MS });
	const contractId = request.contractId.trim();

	// The spec, when the contract has one. A WASM token's spec says which
	// members it declares, so undeclared ones report NOT_IMPLEMENTED without
	// spending a call; a SAC has none and every member is attempted blind.
	const inspected = await inspectContract(server, contractId);
	const specFunctions = inspected.kind === "wasm" ? inspected.functions : null;

	// Simulation needs a source account with a sequence number. The wallet's
	// own account is the natural one — it is the account that will sign.
	const source = await server.getAccount(request.ownerAddress);

	const signer =
		request.ownerSigner ??
		freighterSigner(request.ownerAddress, request.networkPassphrase);

	const spender = await spenderParty(
		request,
		server,
		source,
		// An asset contract by its executable, not by a spec that could not
		// be read: WASM whose spec cannot be read is a custom token.
		inspected.kind === "native" && inspected.stellarAsset,
		onStage,
	);
	// The setup's own transactions count like the suite's writes: every read
	// after them must describe state from the ledger they landed in, or after.
	// So does the ledger the request names, past which an earlier run's
	// transaction may have moved the wallet's balance.
	const soundness: Sep41Context["soundness"] = {};
	noteSettled(soundness, request.minLedger);
	noteSettled(soundness, spender.settledThrough);

	const ctx: Sep41Context = {
		server,
		contractId,
		source,
		networkPassphrase: request.networkPassphrase,
		specFunctions,
		parties: {
			owner: {
				address: request.ownerAddress,
				signer,
				isThrowaway: false,
			},
			spender: spender.party,
		},
		// Fresh per run, exactly as the CLI builds them.
		establishedAllowances: new Set(),
		soundness,
	};

	const assessed = await runSuite(sep41Suite, ctx, (event) => {
		if (event.kind === "finished") {
			onProgress?.(event.completed, event.total);
		}
	});
	const results = withCoverageGaps(assessed);
	const settled = () =>
		soundness.settledThrough === undefined
			? {}
			: { settledThrough: soundness.settledThrough };
	// With no send-back to wait on it, a write whose outcome stayed unknown
	// goes to the page, which holds the next run until it can no longer land.
	const open = soundness.unresolvedWrite;
	const unresolved =
		open === undefined || open.txHash === "" ? {} : { unresolvedWrite: open };
	if (spender.temporary === undefined) {
		return {
			results,
			exitCode: exitCodeFor(results),
			...settled(),
			...unresolved,
			...(spender.setupFailed === undefined
				? {}
				: { spenderSetupFailed: spender.setupFailed }),
		};
	}
	const temporary = spender.temporary;
	// XLM is not sent back: what the account holds there is almost entirely
	// Friendbot's funding, not the visitor's. An asset contract whose asset
	// could not be read may be XLM's, and an issued asset's would have given
	// the account no trustline to hold any units: either way there is
	// nothing to send back.
	if (temporary.asset === "native" || temporary.asset === "unidentified") {
		return {
			results,
			exitCode: exitCodeFor(results),
			cleanup: { returned: 0n, ...settled() },
			...settled(),
			...unresolved,
		};
	}
	// Each cleanup, and each one a retry leads to, says where the run's
	// transactions have settled by then: a retry can find a receipt, or
	// land a send-back, after the run has returned.
	const reported = (cleanup: Cleanup): Cleanup => {
		if ("returned" in cleanup || cleanup.retry === undefined) {
			return { ...cleanup, ...settled() };
		}
		const retry = cleanup.retry;
		return {
			...cleanup,
			...settled(),
			retry: async () => reported(await retry()),
		};
	};
	// A failed return keeps the temporary account's key alive in `retry`, so
	// the page can try again instead of stranding the units: the key exists
	// nowhere else, and without it the units cannot be moved.
	const attempt = async (): Promise<Cleanup> => {
		onStage?.("Sending the temporary account's units back to your wallet…");
		const outcome = await returnUnits(server, request, temporary, soundness);
		if ("returned" in outcome) {
			return outcome;
		}
		if ("pending" in outcome) {
			const { transfer, amount } = outcome.pending;
			return waitForCleanupReceipt(
				server,
				soundness,
				transfer,
				"the transfer back could not be confirmed",
				async (succeeded) => (succeeded ? { returned: amount } : attempt()),
			);
		}
		return outcome.retryable
			? { failed: outcome.failed, retry: attempt }
			: { failed: outcome.failed };
	};
	const pending = soundness.unresolvedWrite;
	const cleanup =
		pending === undefined
			? await attempt()
			: waitForCleanupReceipt(
					server,
					soundness,
					pending,
					"cleanup is paused while an earlier transaction is unresolved",
					attempt,
				);
	return {
		results,
		exitCode: exitCodeFor(results),
		cleanup: reported(cleanup),
		...settled(),
	};
}
