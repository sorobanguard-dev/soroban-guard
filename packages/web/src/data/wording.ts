/**
 * The checks' hints, reworded for someone using the browser.
 *
 * The suite speaks to a terminal: "set SPENDER_ADDRESS to a different
 * account", "OWNER_SECRET to grant the allowance". In a browser there are
 * no environment variables — the holder is the connected wallet and the
 * spender is the counterparty field — so those words sent visitors looking
 * for settings that do not exist. Only the display changes; the CHECKS.md
 * and JSON exports keep the suite's own words, since they are the record.
 *
 * Specific phrasings first, general ones after, so a sentence is rewritten
 * as a whole where one exists rather than word by word.
 */
const REWRITES: readonly (readonly [RegExp, string])[] = [
	[
		/([\w-]+) needs both keys: OWNER_SECRET to grant the allowance and SPENDER_SECRET to (spend it|attempt the spend)/g,
		"$1 needs a second account that signs as the spender — leave the counterparty field empty and the page supplies one, or use the CLI with both keys",
	],
	[
		/set OWNER_ADDRESS and SPENDER_ADDRESS to a real approving pair/g,
		"enter a counterparty this wallet has approved",
	],
	[
		/set OWNER_ADDRESS for a real assertion/g,
		"connect a wallet that holds this token",
	],
	[
		/point OWNER_ADDRESS at an address that holds this token/g,
		"connect a wallet that holds this token",
	],
	[
		/point OWNER_SECRET at a holding account/g,
		"connect a wallet that holds this token",
	],
	[
		/set OWNER_SECRET to an account that both signs and holds this token/g,
		"connect a wallet that holds this token",
	],
	[/set OWNER_SECRET to /g, "connect a wallet to "],
	[
		/set SPENDER_SECRET to /g,
		"a second account signing as the spender is needed to ",
	],
	[
		/set SPENDER_ADDRESS to a different account/g,
		"enter a different counterparty address",
	],
	[
		/set SPENDER_ADDRESS to an account you control/g,
		"enter a counterparty address you control",
	],
	[
		/point SPENDER_ADDRESS at a non-issuer account/g,
		"enter a counterparty that is not the issuer",
	],
	[/its key is discarded at exit/g, "nobody holds its key"],
];

/**
 * What a network refusal code means for the person holding the wallet.
 *
 * When the network rejects a signed transaction, the SDK's error is a
 * generic first line followed by a JSON dump whose `result` field is the
 * real reason — `tx_insufficient_balance` for a wallet sitting on exactly
 * its reserve, which is what a visitor first hit here. The dump is kept in
 * the row's drawer; this is the sentence on the row.
 */
const NETWORK_REFUSALS: Readonly<Record<string, string>> = {
	tx_insufficient_balance:
		"the wallet has too little XLM to pay the fee — send it some testnet XLM and run again",
	tx_insufficient_fee:
		"the fee was lowered below what the network requires — approve the fee Freighter proposes",
	tx_bad_auth:
		"the signature did not match the account — check Freighter is on Testnet and signing with the connected account",
	tx_bad_seq:
		"the wallet sent another transaction at the same time — run again",
	tx_too_late:
		"the approval came after the transaction expired — run again and approve sooner",
	tx_no_account:
		"the wallet's account does not exist on testnet yet — fund it with Friendbot first",
};

/**
 * A plain explanation of why a write never reached the ledger, when the
 * error carries a network result code this page knows; `undefined`
 * otherwise, so the caller falls back to the error's own first line.
 */
export function explainFailure(error: string): string | undefined {
	const code = /"result":\s*"(tx_[a-z_]+)"/.exec(error)?.[1];
	return code === undefined ? undefined : NETWORK_REFUSALS[code];
}

export function forBrowser(text: string): string {
	return REWRITES.reduce(
		(current, [pattern, replacement]) => current.replace(pattern, replacement),
		text,
	);
}
