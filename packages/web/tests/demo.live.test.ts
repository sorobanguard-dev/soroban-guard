import { Keypair, rpc } from "@stellar/stellar-sdk";
import { KeypairSigner } from "@stellar/stellar-sdk/contract";
import { fundAccount } from "soroban-guard/src/core/funding.ts";
import { describe, expect, it } from "vitest";
import { DEMO_CONTRACT, DEMO_FAUCET_UNITS } from "../src/data/demo.ts";
import {
	claimDemoTokens,
	runChecks,
	tokenBalance,
} from "../src/scripts/run.ts";

/**
 * A first-time visitor on /run, against the live demo token.
 *
 * The page's own functions, in the page's order: a brand-new account,
 * the faucet, then all sixteen checks with the counterparty field left
 * empty. Only the wallet popup is absent — a key signs where Freighter
 * would. Hits testnet and takes minutes, so it runs only when asked:
 *
 *   SOROBAN_GUARD_LIVE=1 pnpm test tests/demo.live.test.ts
 */
const RPC = "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const flag = process.env.SOROBAN_GUARD_LIVE;
// Anything but unset or "1" is a mistake — `true`, `yes` — and a silent
// skip would look like a pass. Say so instead.
if (flag !== undefined && flag !== "1") {
	throw new Error(
		`SOROBAN_GUARD_LIVE is "${flag}"; set it to 1 to run the live test, or unset it to skip`,
	);
}
const live = flag === "1";

describe.skipIf(!live)("the demo token, as a new visitor", () => {
	it(
		"takes faucet units and finds the fixture's two defects",
		async () => {
			const visitor = Keypair.random();
			const address = visitor.publicKey();
			const signer = new KeypairSigner(visitor, PASSPHRASE);
			const target = {
				contractId: DEMO_CONTRACT,
				rpcUrl: RPC,
				networkPassphrase: PASSPHRASE,
			};

			await fundAccount(new rpc.Server(RPC), address);
			expect(await tokenBalance(target, address)).toBe(0n);

			await claimDemoTokens(target, address, signer);
			expect(await tokenBalance(target, address)).toBe(
				BigInt(DEMO_FAUCET_UNITS),
			);

			const stages: string[] = [];
			const outcome = await runChecks(
				{ ...target, ownerAddress: address, ownerSigner: signer },
				undefined,
				(stage) => stages.push(stage),
			);
			const count = (status: string) =>
				outcome.results.filter((r) => r.status === status).length;

			// The page funded a second account rather than reusing the holder.
			expect(stages.some((s) => s.includes("temporary second account"))).toBe(
				true,
			);
			// A custom WASM token needs no trustline, so the page adds none.
			expect(stages.some((s) => s.includes("trustline"))).toBe(false);
			expect(
				outcome.results
					// "are the same address" is the refusal to measure; the
					// self-transfer finding legitimately says "the same address".
					.filter((r) => r.actual.includes("are the same address"))
					.map((r) => `${r.id}: ${r.actual}`),
			).toEqual([]);

			expect(outcome.results.map((r) => [r.id, r.status])).toContainEqual([
				"sep41-transfer-self",
				"FAIL",
			]);
			expect(outcome.results.map((r) => [r.id, r.status])).toContainEqual([
				"sep41-transfer-negative-amount",
				"FAIL",
			]);
			expect([count("PASS"), count("FAIL"), count("UNVERIFIABLE")]).toEqual([
				9, 2, 5,
			]);
			expect(outcome.exitCode).toBe(1);
		},
		10 * 60 * 1000,
	);
});
