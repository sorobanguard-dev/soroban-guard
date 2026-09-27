import { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { runSuite } from "../../../src/core/runner.ts";
import { inspectContract } from "../../../src/core/spec.ts";
import type { Sep41Context } from "../../../src/sep41/context.ts";
import { sep41Suite, withCoverageGaps } from "../../../src/sep41/index.ts";

const CONTRACT = process.env.TESTNET_CONTRACT_ID;
const RPC_URL =
	process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE =
	process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const OWNER = process.env.OWNER_ADDRESS;
const SPENDER = process.env.SPENDER_ADDRESS;

describe.skipIf(!(CONTRACT && OWNER && SPENDER))(
	"SEP-41 suite against a live token",
	() => {
		it("the five reads PASS and the rest report honestly", async () => {
			if (!CONTRACT || !OWNER || !SPENDER) {
				throw new Error("unreachable: env guard skipped this suite");
			}
			const server = new rpc.Server(RPC_URL);
			const source = await server.getAccount(OWNER);
			const inspected = await inspectContract(server, CONTRACT);
			const ctx: Sep41Context = {
				server,
				contractId: CONTRACT,
				source,
				networkPassphrase: PASSPHRASE,
				parties: {
					owner: { address: OWNER, isThrowaway: false },
					spender: { address: SPENDER, isThrowaway: false },
				},
				specFunctions: inspected.kind === "wasm" ? inspected.functions : null,
				establishedAllowances: new Set(),
				soundness: {},
			};
			const assessed = await runSuite(sep41Suite, ctx);
			const results = withCoverageGaps(assessed);
			// Sixteen checks, no gaps: if the suite grows or shrinks without
			// this file following, the count fails first, not silently.
			expect(results).toHaveLength(16);
			// Distinct ids, because the count alone does not imply them: one
			// id duplicated and another dropped still totals sixteen, and
			// every `find` below would still succeed while a check had
			// silently vanished from the run.
			expect(new Set(results.map((r) => r.id)).size).toBe(16);
			// Asserted by id, never by position. Positional slices broke
			// silently every time the suite grew, and these tests only run
			// with env configured — so CI never caught it.
			const byId = (id: string) => results.find((r) => r.id === id);

			for (const id of [
				"sep41-decimals",
				"sep41-balance",
				"sep41-allowance",
				"sep41-name",
				"sep41-symbol",
			]) {
				const result = byId(id);
				expect(
					result?.status,
					`${id} → ${result?.actual} ${result?.evidence.error ?? ""}`,
				).toBe("PASS");
			}

			// The writes run but hold no key, so each reports about this run
			// rather than about the contract.
			for (const id of [
				"sep41-transfer",
				"sep41-approve",
				"sep41-transfer_from",
				"sep41-transfer_from-unauthorized",
				"sep41-burn",
				"sep41-burn_from",
			]) {
				const result = byId(id);
				expect(result?.status, `${id} → ${result?.actual}`).toBe(
					"UNVERIFIABLE",
				);
			}

			// Every required member is assessed now, so a gap row means the
			// suite lost a check.
			const gaps = results.filter(
				(r) => r.actual === "not assessed by this suite",
			);
			expect(gaps.map((r) => r.id)).toEqual([]);
		}, 60_000);
	},
);
