import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { explainFailure, forBrowser } from "../src/data/wording.ts";

/**
 * Every hint the checks can print, read from their source rather than
 * copied here — so a new message that names a CLI setting fails this test
 * until the browser has words for it.
 */
const checksDir = fileURLToPath(
	new URL("../../soroban-guard/src/sep41/checks/", import.meta.url),
);

const MESSAGES = [
	...new Set(
		readdirSync(checksDir)
			.filter((name) => name.endsWith(".ts"))
			.flatMap((name) => {
				const source = readFileSync(`${checksDir}${name}`, "utf8");
				return (
					[
						...source.matchAll(
							/["`]([^"`]*(?:OWNER|SPENDER)_(?:SECRET|ADDRESS)[^"`]*)["`]/g,
						),
					]
						.map((match) => match[1])
						// A hint is a sentence; a bare `SPENDER_SECRET` is a code
						// comment naming the variable, which no visitor sees.
						.filter((text) => text.includes(" "))
				);
			}),
	),
];

describe("forBrowser", () => {
	it("finds the hints it has to translate", () => {
		expect(MESSAGES.length).toBeGreaterThan(20);
	});

	it.each(MESSAGES)("leaves no CLI setting in: %s", (message) => {
		expect(forBrowser(message)).not.toMatch(/(OWNER|SPENDER)_(SECRET|ADDRESS)/);
	});

	it("rewrites the both-keys hint as a whole sentence", () => {
		expect(
			forBrowser(
				"expired-allowance needs both keys: OWNER_SECRET to grant the allowance and SPENDER_SECRET to attempt the spend",
			),
		).toBe(
			"expired-allowance needs a second account that signs as the spender — leave the counterparty field empty and the page supplies one, or use the CLI with both keys",
		);
	});

	it("leaves text without CLI settings alone", () => {
		expect(forBrowser("allowance is 2 after approving 2 over 1")).toBe(
			"allowance is 2 after approving 2 over 1",
		);
	});
});

describe("explainFailure", () => {
	// Verbatim from a visitor's run: a wallet holding exactly its 1 XLM
	// reserve, every write refused before it reached the ledger.
	const refused =
		'Sending the transaction to the network failed!\n{ "status": "ERROR", "hash": "2c9cd2c7f8a4e31bdd83e7fb7b8d2f16368c2fd0d827f360f37e1135292f5aa3", "latestLedger": 4951784, "latestLedgerCloseTime": "1790782507", "errorResult": { "fee_charged": "134010", "result": "tx_insufficient_balance", "ext": "v0" } }';

	it("names an underfunded wallet in the wallet's terms", () => {
		expect(explainFailure(refused)).toMatch(/too little XLM/);
	});

	it("says nothing about an error it does not recognise", () => {
		expect(explainFailure("fetch failed")).toBeUndefined();
		expect(
			explainFailure('{ "errorResult": { "result": "tx_something_new" } }'),
		).toBeUndefined();
	});
});

describe("forBrowser, unchanged text", () => {
	it("leaves text without CLI settings alone", () => {
		expect(forBrowser("allowance is 2 after approving 2 over 1")).toBe(
			"allowance is 2 after approving 2 over 1",
		);
	});
});
