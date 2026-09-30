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
import { Keypair, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import { KeypairSigner, type Signer } from "@stellar/stellar-sdk/contract";
import { fundAccount } from "soroban-guard/src/core/funding.ts";
import {
	addressArg,
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
 * The second party, when the visitor did not name one.
 *
 * On the demo token, a real second account: generated, funded by Friendbot,
 * and signed for by this page, so the four checks that must sign as the
 * spender run too and a visitor with one wallet gets all sixteen. Its key
 * lives only in this tab and dies with it; what the run sends there is a
 * few units of a token anyone can take from the faucet, so nothing of value
 * is stranded.
 *
 * On any other token, the CLI's rule instead: a generated address with no
 * key, marked throwaway, so the suite refuses to move anyone's real tokens
 * to an account nobody can recover and says what it would need.
 */
async function spenderParty(
	request: RunRequest,
	server: rpc.Server,
	onStage?: (text: string) => void,
): Promise<Party> {
	const named = request.spenderAddress?.trim();
	if (named !== undefined && named !== "") {
		return { address: named, isThrowaway: false };
	}
	const keypair = Keypair.random();
	if (!isDemoContract(request.contractId)) {
		return { address: keypair.publicKey(), isThrowaway: true };
	}
	onStage?.("Funding a second test account to act as the spender…");
	await fundAccount(server, keypair.publicKey());
	return {
		address: keypair.publicKey(),
		signer: new KeypairSigner(keypair, request.networkPassphrase),
		isThrowaway: false,
	};
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
			spender: await spenderParty(request, server, onStage),
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
	return { results, exitCode: exitCodeFor(results) };
}
