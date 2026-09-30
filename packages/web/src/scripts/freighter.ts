/**
 * Freighter as a `Signer`, so the checks run unchanged in a browser.
 *
 * The suite asks a `Signer` for two things — sign this transaction, sign
 * this authorization entry — and never asks where the key lives. The CLI
 * answers with a `KeypairSigner` holding a secret from the environment;
 * here the answer is a wallet extension the visitor controls, and no key
 * ever reaches this page. That is the whole reason the same sixteen checks
 * can run in a browser at all: the signer is the only part of the context
 * that had to change.
 *
 * Talks to the extension through `@stellar/freighter-api`, which messages
 * Freighter's content script with `window.postMessage`. An earlier version
 * waited for a `window.freighterApi` global instead, on the belief that the
 * extension injects one. It does not: that global exists only on pages that
 * load the library's CDN build, so the page reported "Freighter did not
 * respond" to every visitor who had it installed.
 *
 * Every call is guarded, because an extension can be absent, locked, or on
 * the wrong network, and each of those is a fact about the run rather than
 * about the contract.
 */
import {
	getNetwork,
	isConnected,
	requestAccess,
	signAuthEntry,
	signTransaction,
} from "@stellar/freighter-api";

/** Thrown when the wallet is missing, locked, or refuses. */
export class WalletError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WalletError";
	}
}

/**
 * The text of a Freighter error.
 *
 * Freighter reports errors as `{ code, message }` objects, not strings. The
 * earlier code passed them straight to `new Error(...)`, which would have
 * shown the visitor "[object Object]". The library's own type for this
 * points at a file its published package does not ship, so the value is
 * narrowed here rather than trusted.
 */
function errorText(error: unknown): string | undefined {
	if (error === undefined || error === null || error === "") {
		return undefined;
	}
	if (typeof error === "string") {
		return error;
	}
	if (typeof error === "object" && "message" in error) {
		const message = (error as { message: unknown }).message;
		if (typeof message === "string" && message !== "") {
			return message;
		}
	}
	return "Freighter reported an error without a message.";
}

function throwIfError(result: { error?: unknown }): void {
	const text = errorText(result.error);
	if (text !== undefined) {
		throw new WalletError(text);
	}
}

/**
 * Whether the Freighter extension is installed in this browser.
 *
 * `isConnected()` is the library's own installation check, and the one call
 * it guarantees returns when the extension is absent: its other calls post
 * a message and wait for a reply, and with nothing installed to answer, the
 * library's own source notes they hang forever. So this runs before any of
 * them.
 */
/*
 * Why more than one attempt: the library gives the extension a flat 2
 * seconds to answer, then reports "not connected". An installed Freighter
 * can miss that — its content script relays the question to a background
 * worker the browser may have put to sleep, and waking it is not instant.
 * One slow reply used to make the page tell a visitor with Freighter open
 * that it was not installed, and refuse to connect. Three attempts give a
 * sleeping worker six seconds; a browser without the extension still gets
 * a definite answer.
 */
const PROBE_ATTEMPTS = 3;

// Once seen, the extension does not uninstall itself mid-visit.
let seen = false;

export async function isFreighterInstalled(): Promise<boolean> {
	for (let attempt = 0; attempt < PROBE_ATTEMPTS && !seen; attempt += 1) {
		try {
			const result = await isConnected();
			seen = result.isConnected === true;
		} catch {
			// A throw is as inconclusive as a timeout; try again.
		}
	}
	return seen;
}

/**
 * Ask for access and return the address that granted it.
 *
 * `requestAccess` is what prompts the extension's approval dialog, and
 * returns the address straight away if this site is already allowed.
 */
export async function connect(): Promise<string> {
	if (!(await isFreighterInstalled())) {
		throw new WalletError(
			"Freighter is not installed in this browser. Install it from freighter.app, then reload this page.",
		);
	}
	const granted = await requestAccess();
	throwIfError(granted);
	// A dismissed dialog, or a locked wallet, can resolve without an error
	// and without an address. Passing that onward surfaces as an opaque SDK
	// error instead of the wallet problem it actually is.
	if (typeof granted.address !== "string" || granted.address === "") {
		throw new WalletError(
			"Freighter returned no address. It may be locked, or the request was dismissed — open the extension, unlock it, and try again.",
		);
	}
	return granted.address;
}

/** The network the wallet is pointed at, which has to match the run's. */
export async function walletNetwork(): Promise<{
	network: string;
	networkPassphrase: string;
}> {
	const result = await getNetwork();
	throwIfError(result);
	// The passphrase is what every signature is bound to; without it the
	// run would sign for an unknown network and the failures would read as
	// contract faults.
	if (
		typeof result.networkPassphrase !== "string" ||
		result.networkPassphrase === ""
	) {
		throw new WalletError(
			"Freighter did not report which network it is on. Reopen the extension and try again.",
		);
	}
	return {
		network: result.network,
		networkPassphrase: result.networkPassphrase,
	};
}

/**
 * Refuse a signature from an account other than the one the run connected.
 *
 * Freighter signs with whichever account is selected when the prompt
 * appears, and reports which one it used. Switching accounts mid-run would
 * otherwise have the rest of the suite signed by a different party than
 * the one every balance and allowance is being measured against — and the
 * resulting verdicts would describe the contract, wrongly.
 */
function requireSigner(signerAddress: unknown, address: string): void {
	if (
		typeof signerAddress === "string" &&
		signerAddress !== "" &&
		signerAddress !== address
	) {
		throw new WalletError(
			`Freighter signed as ${signerAddress}, but this run connected as ${address}. Switch Freighter back to that account, or reconnect, and run again.`,
		);
	}
}

/**
 * A `Signer` backed by the connected wallet.
 *
 * Shaped to the SDK's `Signer` interface rather than importing the type,
 * because this package must not depend on the SDK's internal module layout
 * to describe an object it only ever passes onward. The suite consumes
 * `address`, `signTransaction` and `signAuthEntry`; supplying exactly those
 * keeps the structural match explicit.
 *
 * Every write in the suite becomes an approval prompt. That is the point —
 * the visitor sees each transaction before it is signed — but it also means
 * a full run asks for several signatures in a row, which the page warns
 * about before starting.
 */
export function freighterSigner(address: string, networkPassphrase: string) {
	return {
		address,
		async signTransaction(xdr: string) {
			const signed = await signTransaction(xdr, { networkPassphrase, address });
			throwIfError(signed);
			// A dismissed prompt can come back with no error and nothing
			// signed. Passing an empty XDR onward would fail inside the
			// submission as an opaque decode error — a wallet problem
			// wearing a contract problem's clothes, which is exactly the
			// confusion this tool exists to prevent.
			if (typeof signed.signedTxXdr !== "string" || signed.signedTxXdr === "") {
				throw new WalletError(
					"Freighter returned no signed transaction. The request may have been dismissed — approve the prompt to continue.",
				);
			}
			requireSigner(signed.signerAddress, address);
			return {
				signedTxXdr: signed.signedTxXdr,
				signerAddress: signed.signerAddress,
			};
		},
		async signAuthEntry(xdr: string) {
			const signed = await signAuthEntry(xdr, { networkPassphrase, address });
			throwIfError(signed);
			// The library types this as `string | null`: null is a refusal
			// that arrived without an error, and must not be passed on.
			if (
				typeof signed.signedAuthEntry !== "string" ||
				signed.signedAuthEntry === ""
			) {
				throw new WalletError(
					"Freighter returned no signed authorization entry. The request may have been dismissed — approve the prompt to continue.",
				);
			}
			requireSigner(signed.signerAddress, address);
			return {
				signedAuthEntry: signed.signedAuthEntry,
				signerAddress: signed.signerAddress,
			};
		},
	};
}
