import { createHash } from "node:crypto";
import { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CONFORMANCE_RUNS } from "../src/data/conformance-table.ts";

/**
 * The /results page names the WASM hash of each contract built from
 * source. This asks testnet for the code actually deployed there, so the
 * hash on the page cannot drift from the chain unnoticed. Hits the
 * network, so it runs only when asked:
 *
 *   SOROBAN_GUARD_LIVE=1 pnpm test tests/results.live.test.ts
 */
const RPC = "https://soroban-testnet.stellar.org";
const flag = process.env.SOROBAN_GUARD_LIVE;
if (flag !== undefined && flag !== "1") {
	throw new Error(
		`SOROBAN_GUARD_LIVE is "${flag}"; set it to 1 to run the live test, or unset it to skip`,
	);
}
const live = flag === "1";

const built = CONFORMANCE_RUNS.filter((run) => run.wasmHash !== undefined);

describe.skipIf(!live)("results page contracts, on testnet", () => {
	it.each(built.map((run) => [run.name, run] as const))(
		"%s serves the wasm the page names",
		async (_name, run) => {
			const wasm = await new rpc.Server(RPC).getContractWasmByContractId(
				run.contractId,
			);
			expect(createHash("sha256").update(wasm).digest("hex")).toBe(
				run.wasmHash,
			);
		},
		30_000,
	);
});
