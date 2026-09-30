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
		"$1 needs a second account that signs as the spender — use the demo token with the counterparty field empty, or the CLI with both keys",
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

export function forBrowser(text: string): string {
	return REWRITES.reduce(
		(current, [pattern, replacement]) => current.replace(pattern, replacement),
		text,
	);
}
