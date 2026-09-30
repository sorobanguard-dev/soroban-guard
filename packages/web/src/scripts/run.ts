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
import { fundAccount } from "soroban-guard/src/core/funding.ts";
import {
	addressArg,
	amountArg,
	interpretSimulation,
	simulateRead,
	submitWrite,
} from "soroban-guard/src/core/invoke.ts";
import { exitCodeFor } from "soroban-guard/src/core/report.ts";
import { runSuite } from "soroban-guard/src/core/runner.ts";
import { inspectContract } from "soroban-guard/src/core/spec.ts";
import type { CheckResult } from "soroban-guard/src/core/types.ts";
import type { Party, Sep41Context } from "soroban-guard/src/sep41/context.ts";
import { sep41Suite, withCoverageGaps } from "soroban-guard/src/sep41/index.ts";
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
	 *
	 * Optional, and its absence costs real coverage: the transfer and
	 * allowance checks need a counterparty that is not the holder, and say
	 * so rather than guessing. Deliberately not a count — an earlier
	 * version claimed eight, which matched nothing in the suite; the
	 * checks themselves report what they could not establish, and that
	 * number is the one worth trusting.
	 *
	 * Left empty, the run supplies one — see `spenderParty`. It used to
	 * fall back to the holder's own address, which made every transfer a
	 * self-transfer and left seven checks saying "same address".
	 */
	readonly spenderAddress?: string;
	/**
	 * Who signs as the holder. The connected wallet when absent, which is
	 * every real use; supplying a key instead lets the exact browser path —
	 * throwaway spender, faucet, all sixteen checks — be exercised from a
	 * script, with nothing standing in for it but the popup.
	 */
	readonly ownerSigner?: Signer;
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
): Promise<Asset | "native" | undefined> {
	const outcome = interpretSimulation(
		await simulateRead(
			server,
			source,
			{ contractId: request.contractId.trim(), method: "name", args: [] },
			request.networkPassphrase,
		),
	);
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

/** Give the temporary account a trustline, and wait for it to land. */
async function addTrustline(
	server: rpc.Server,
	keypair: Keypair,
	asset: Asset,
	networkPassphrase: string,
): Promise<void> {
	const account = await server.getAccount(keypair.publicKey());
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase,
	})
		.addOperation(Operation.changeTrust({ asset }))
		.setTimeout(60)
		.build();
	tx.sign(keypair);
	const sent = await server.sendTransaction(tx);
	if (sent.status !== "PENDING") {
		throw new Error(
			`the temporary account's trustline to ${asset.getCode()} was refused (${sent.status})`,
		);
	}
	const settled = await server.pollTransaction(sent.hash, { attempts: 20 });
	if (settled.status !== "SUCCESS") {
		throw new Error(
			`the temporary account's trustline to ${asset.getCode()} did not land (${settled.status})`,
		);
	}
}

/** The second party the run supplies, with what the page needs to clean up. */
interface TemporarySpender {
	readonly party: Party;
	readonly keypair: Keypair;
	readonly asset: Asset | "native" | undefined;
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
}> {
	const named = request.spenderAddress?.trim();
	if (named !== undefined && named !== "") {
		return { party: { address: named, isThrowaway: false } };
	}
	const keypair = Keypair.random();
	try {
		onStage?.("Creating a temporary second account to sign as the spender…");
		await fundAccount(server, keypair.publicKey());
		// Only a Stellar Asset Contract wraps a classic asset. A custom
		// token's name is whatever its author chose, and one that happens to
		// read CODE:ISSUER must not buy a trustline it does not need.
		const asset = isAssetContract
			? await wrappedAsset(server, request, source)
			: undefined;
		if (asset instanceof Asset) {
			onStage?.(
				`Giving the temporary account a trustline to ${asset.getCode()}…`,
			);
			await addTrustline(server, keypair, asset, request.networkPassphrase);
		}
		const party: Party = {
			address: keypair.publicKey(),
			signer: new KeypairSigner(keypair, request.networkPassphrase),
			isThrowaway: false,
		};
		return { party, temporary: { party, keypair, asset } };
	} catch (error) {
		// Setup trouble — Friendbot down, a trustline refused — must cost the
		// four checks that need a second signer, not all sixteen. Fall back
		// to the keyless generated address the suite already knows how to
		// report on: the reads and the holder's own writes still run.
		return {
			party: { address: keypair.publicKey(), isThrowaway: true },
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
 * run into an error. XLM is left alone: what the account holds there is
 * almost entirely Friendbot's funding, not the visitor's.
 */
async function returnUnits(
	server: rpc.Server,
	request: RunRequest,
	temporary: TemporarySpender,
): Promise<{ returned: bigint } | { failed: string }> {
	if (temporary.asset === "native") {
		return { returned: 0n };
	}
	try {
		const source = await server.getAccount(temporary.party.address);
		const read = interpretSimulation(
			await simulateRead(
				server,
				source,
				{
					contractId: request.contractId.trim(),
					method: "balance",
					args: [addressArg(temporary.party.address)],
				},
				request.networkPassphrase,
			),
		);
		const held =
			read.kind === "ok" && typeof read.value === "bigint" ? read.value : 0n;
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
			},
			request.networkPassphrase,
		);
		return sent.kind === "applied"
			? { returned: held }
			: { failed: `the transfer back was not applied (${sent.kind})` };
	} catch (error) {
		return { failed: error instanceof Error ? error.message : String(error) };
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
 * not complete. Sponsorships and liabilities are ignored: a wallet
 * sophisticated enough to have them is not the one this protects.
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
		found = await new rpc.Server(rpcUrl).getLedgerEntry(key);
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
	const reserve = (2n + BigInt(entry.numSubEntries)) * BASE_RESERVE;
	return entry.balance - reserve;
}

/**
 * The wallet's balance of the token, read before any write is attempted.
 *
 * `undefined` when the balance could not be read at all — a contract that
 * traps on `balance`, say. That is the suite's to judge, so the page then
 * runs rather than guessing.
 */
export async function tokenBalance(
	request: Pick<RunRequest, "rpcUrl" | "networkPassphrase" | "contractId">,
	address: string,
): Promise<bigint | undefined> {
	const server = new rpc.Server(request.rpcUrl);
	const source = await server.getAccount(address);
	const simulation = await simulateRead(
		server,
		source,
		{
			contractId: request.contractId.trim(),
			method: "balance",
			args: [addressArg(address)],
		},
		request.networkPassphrase,
	);
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
	request: Pick<RunRequest, "rpcUrl" | "networkPassphrase" | "contractId">,
	address: string,
	signer: Signer = freighterSigner(address, request.networkPassphrase),
): Promise<void> {
	if (!isDemoContract(request.contractId)) {
		throw new Error("Test tokens are only available for the demo token.");
	}
	const server = new rpc.Server(request.rpcUrl);
	const outcome = await submitWrite(
		server,
		{
			contractId: request.contractId.trim(),
			method: "faucet",
			args: [addressArg(address)],
			signer,
		},
		request.networkPassphrase,
	);
	if (outcome.kind === "timeout") {
		throw new Error(
			"The faucet transaction was sent but not confirmed in time. Wait a few seconds and check your balance.",
		);
	}
	if (outcome.kind !== "applied") {
		throw new Error(
			`The faucet call did not go through: ${outcome.diagnostics}`,
		);
	}
}

export interface RunOutcome {
	readonly results: readonly CheckResult[];
	readonly exitCode: number;
	/**
	 * When the run supplied its own second account: how many units went back
	 * to the holder at the end, or why they could not. Absent when the
	 * visitor named the counterparty.
	 */
	readonly cleanup?: { returned: bigint } | { failed: string };
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
 * Sequential and slow by nature: each write waits for a ledger to close,
 * and the expiry check waits for two. `onProgress` exists so the page can
 * show rows as they land rather than a spinner for a minute — the suite
 * itself has no notion of progress, so this wraps it at the check level.
 */
export async function runChecks(
	request: RunRequest,
	onProgress?: (completed: number, total: number) => void,
	onStage?: (text: string) => void,
): Promise<RunOutcome> {
	const server = new rpc.Server(request.rpcUrl);
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
		inspected.kind === "native",
		onStage,
	);

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
		soundness: {},
	};

	const total = sep41Suite.checks.length;
	let completed = 0;
	const instrumented = {
		...sep41Suite,
		checks: sep41Suite.checks.map((check) => ({
			...check,
			async run(context: Sep41Context) {
				const result = await check.run(context);
				completed += 1;
				onProgress?.(completed, total);
				return result;
			},
		})),
	};

	const assessed = await runSuite(instrumented, ctx);
	const results = withCoverageGaps(assessed);
	if (spender.temporary === undefined) {
		return {
			results,
			exitCode: exitCodeFor(results),
			...(spender.setupFailed === undefined
				? {}
				: { spenderSetupFailed: spender.setupFailed }),
		};
	}
	onStage?.("Sending the temporary account's units back to your wallet…");
	const cleanup = await returnUnits(server, request, spender.temporary);
	return { results, exitCode: exitCodeFor(results), cleanup };
}
