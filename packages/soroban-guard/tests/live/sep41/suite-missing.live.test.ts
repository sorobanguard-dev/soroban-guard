import { Address, rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { runSuite } from "../../../src/core/runner.ts";
import { inspectContract } from "../../../src/core/spec.ts";
import type { Sep41Context } from "../../../src/sep41/context.ts";
import { sep41Suite, withCoverageGaps } from "../../../src/sep41/index.ts";

const RPC_URL =
	process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE =
	process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const OWNER = process.env.OWNER_ADDRESS;
const SPENDER = process.env.SPENDER_ADDRESS;

// The all-zero contract address is assumed undeployed on testnet: grinding
// a deployment to it is infeasible, but if this test ever flips to PASS,
// reinvestigate rather than deleting it.
//
// Note the CLI itself would refuse this address first (missing → exit 2).
// This test bypasses the CLI to prove the suite reports honestly against an
// address with nothing behind it: the reads trap and FAIL with their
// diagnostics preserved, while the writes never reach the address at all —
// no signer is configured, so they report about the run, not the contract.
const EMPTY_CONTRACT = Address.contract(new Uint8Array(32)).toString();

describe.skipIf(!(OWNER && SPENDER))("SEP-41 suite against nothing", () => {
	it("reads FAIL with diagnostics; writes report no signing authority", async () => {
		if (!OWNER || !SPENDER) {
			throw new Error("unreachable: env guard skipped this suite");
		}
		const server = new rpc.Server(RPC_URL);
		const source = await server.getAccount(OWNER);
		const inspected = await inspectContract(server, EMPTY_CONTRACT);
		expect(inspected.kind).toBe("missing");
		const ctx: Sep41Context = {
			server,
			contractId: EMPTY_CONTRACT,
			source,
			networkPassphrase: PASSPHRASE,
			parties: {
				owner: { address: OWNER, isThrowaway: false },
				spender: { address: SPENDER, isThrowaway: false },
			},
			specFunctions: null,
			establishedAllowances: new Set(),
			soundness: {},
		};
		const assessed = await runSuite(sep41Suite, ctx);
		const results = withCoverageGaps(assessed);
		// Sixteen checks even against nothing deployed: the count pins the
		// suite size so growth without updating this file fails loudly.
		expect(results).toHaveLength(16);
		// By id, never by position: positional slices broke silently every
		// time the suite grew, and these tests only run with env configured.
		const byId = (id: string) => results.find((r) => r.id === id);

		// Nothing is deployed here, so every read traps — and a trap with no
		// standing explanation is the contract's own behaviour.
		for (const id of [
			"sep41-decimals",
			"sep41-balance",
			"sep41-allowance",
			"sep41-name",
			"sep41-symbol",
		]) {
			const result = byId(id);
			expect(result?.status, `${id} → ${result?.actual}`).toBe("FAIL");
			expect(result?.evidence.error).toBeDefined();
		}

		// The writes never reach the address: no signer is configured, so
		// they report about this run rather than about the contract. The
		// newer negative checks are listed explicitly rather than covered
		// by the count above, but not because refusal-credit could fire
		// here — without a signer every check below exits before it
		// submits, so that code never runs. What the per-id assertions
		// catch is a signer guard that stops guarding: a check that
		// submitted anyway, or one silently dropped from the suite, both
		// of which the row count alone would miss.
		for (const id of [
			"sep41-transfer",
			"sep41-approve",
			"sep41-transfer_from",
			"sep41-transfer_from-unauthorized",
			"sep41-transfer-over-balance",
			"sep41-transfer-negative-amount",
			"sep41-transfer-zero-amount",
			"sep41-transfer-self",
			"sep41-transfer_from-expired",
			"sep41-burn",
			"sep41-burn_from",
		]) {
			const result = byId(id);
			expect(result?.status, `${id} → ${result?.actual}`).toBe("UNVERIFIABLE");
		}

		const gaps = results.filter(
			(r) => r.actual === "not assessed by this suite",
		);
		expect(gaps.map((r) => r.id)).toEqual([]);
	}, 60_000);
});
