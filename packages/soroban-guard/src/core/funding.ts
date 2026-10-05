/**
 * Testnet account provisioning: Friendbot funding, and loading a sequence
 * source without losing the reason a load failed.
 *
 * Funding exists so the tool needs no configuration — probe accounts are
 * generated per run and funded here, rather than demanded from the user.
 * Every rule in this file protects the faucet or the diagnosis: check
 * before funding, fund at most once, poll because acceptance is not
 * application, and never convert a transport failure into "absent".
 *
 * XLM only. Token balances and trustlines are the caller's problem — a
 * funded account can still hold nothing of the token under test, which is
 * why probe reads report UNVERIFIABLE rather than a vacuous PASS.
 */
import { Account, Keypair, type rpc, xdr } from "@stellar/stellar-sdk";

export interface FundOptions {
	/** getAccount verification attempts after requesting (default 10). */
	readonly attempts?: number;
	/** Delay between verification attempts in ms (default 2000, 0 allowed). */
	readonly delayMs?: number;
	/**
	 * Sleeper, injectable so tests can record waits instead of serving
	 * them. Defaults to a real timer.
	 */
	readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_DELAY_MS = 2000;

function realSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Ledger key for an account entry. Mirrors what the SDK's getAccountEntry
 * builds internally — but read through getLedgerEntry (singular), whose
 * absence error is distinguishable, instead of getAccount, whose catch-all
 * normalizes every failure into "Account not found".
 */
function accountLedgerKey(publicKey: string): xdr.LedgerKey {
	let accountId: ReturnType<Keypair["xdrPublicKey"]>;
	try {
		accountId = Keypair.fromPublicKey(publicKey).xdrPublicKey();
	} catch (error) {
		throw new RangeError(`invalid public key: ${publicKey}`, {
			cause: error,
		});
	}
	return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));
}

/**
 * True when the account entry exists. Absence (no entry for the key) is
 * data; anything else — transport failures, malformed keys — propagates
 * untouched. The "failed to find an entry" text is getLedgerEntry's own
 * absence signal (see its source), never produced for transport problems.
 * Plain-object rejects in other shapes are treated as unknown failures,
 * not absence: only the verified message counts.
 *
 * Verified against SDK 17.2.1 on testnet — an absent account rejects with:
 *
 *     instanceof Error : true
 *     message          : "failed to find an entry for key …"
 *     code             : undefined
 *
 * Note this differs from `getContractInstance`, which rejects with a plain
 * object carrying `code: 404` and no Error prototype (see spec.ts's
 * `isNotFound`). Absence has no single shape across the SDK, so each call
 * site matches the shape its own method produces rather than sharing a
 * predicate. If SDF rewords the message the unmatched error is rethrown,
 * so funding fails loudly until the matcher is updated — it never reads an
 * absent account as present. `funding.live.test.ts` catches the rewording
 * on the next run against testnet.
 */
async function accountExists(
	server: rpc.Server,
	publicKey: string,
): Promise<boolean> {
	try {
		await server.getLedgerEntry(accountLedgerKey(publicKey));
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			/failed to find an entry/i.test(error.message)
		) {
			return false;
		}
		throw error;
	}
}

/**
 * Ensure `publicKey` holds testnet XLM. Check-first: an already-funded
 * account returns without touching the faucet. The faucet fires only for
 * genuinely absent accounts — an outage surfaces from the existence probe
 * before any request goes out, so failures never burn faucet quota.
 * Then poll, because Friendbot's 200 only means accepted, not applied, and
 * blind trust flakes on ledger close. No sleep follows the final poll.
 * Persistent invisibility throws — a harness error for the runner to
 * record, never a contract verdict.
 *
 * Testnet only. Friendbot funds XLM for fees; token balances and trustlines
 * are the caller's business.
 */
export async function fundAccount(
	server: rpc.Server,
	publicKey: string,
	options: FundOptions = {},
): Promise<void> {
	const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
	const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
	const sleep = options.sleep ?? realSleep;
	if (!Number.isInteger(attempts) || attempts < 1) {
		throw new RangeError(
			`funding attempts must be a positive integer, got ${attempts}`,
		);
	}
	if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0) {
		throw new RangeError(
			`funding delay must be a finite non-negative number, got ${delayMs}`,
		);
	}
	if (await accountExists(server, publicKey)) {
		return;
	}
	await server.fundAddress(publicKey);
	for (let attempt = 0; attempt < attempts; attempt++) {
		// Transport failures propagate immediately: mid-poll outages are
		// harness errors, not evidence of absence. Only a confirmed miss
		// waits out another ledger close.
		if (await accountExists(server, publicKey)) {
			return;
		}
		if (attempt < attempts - 1) {
			await sleep(delayMs);
		}
	}
	throw new Error(
		`funding not visible for ${publicKey} after ${attempts} verification checks ` +
			`(faucet accepted the request but the account never appeared — slow ledger close or a dropped request, retrying usually succeeds)`,
	);
}

/**
 * Load the sequence source for simulation from the ledger entry directly.
 * Unlike `getAccount` — whose catch-all normalizes every failure into
 * "Account not found" — errors here keep their identity: absence throws
 * the entry error, outages throw transport errors. Callers that already
 * proved existence (e.g. right after funding) get an honest diagnostic
 * instead of a misdiagnosis.
 */
export async function loadSourceAccount(
	server: rpc.Server,
	publicKey: string,
): Promise<Account> {
	const entry = await server.getLedgerEntry(accountLedgerKey(publicKey));
	// `val` is non-optional in LedgerEntryResult and getLedgerEntry either
	// resolves with one or throws, so it is read directly rather than with
	// `?.` — a guard against a state the type forbids only makes readers
	// wonder what it knows that they do not. The discriminant check below
	// is real: an account key could in principle answer with another entry
	// type, and that deserves a clear error rather than a cast.
	if (entry.val.type !== "account") {
		throw new Error(
			`expected account entry for ${publicKey}, found ${String(entry.val.type)}`,
		);
	}
	const seqNum = entry.val.account.seqNum;
	if (typeof seqNum !== "bigint") {
		throw new Error(`account entry for ${publicKey} has no sequence number`);
	}
	return new Account(publicKey, seqNum.toString());
}
