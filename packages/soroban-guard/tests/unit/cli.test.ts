import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

/** Exercise the CLI in a subprocess with an isolated environment. */
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const CONTRACT = "CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54";

function run(
	args: string[],
	env: Record<string, string> = {},
	preload?: string,
) {
	const imports = preload === undefined ? [] : ["--import", preload];
	const result = spawnSync(process.execPath, [...imports, CLI, ...args], {
		encoding: "utf8",
		// Only what is passed: a developer's own OWNER_SECRET or RPC URL must
		// not leak in and change which path the CLI takes.
		env: { PATH: process.env.PATH ?? "", ...env },
		// spawnSync blocks the worker, so vitest's own timeout cannot fire:
		// a regression that reaches the network would otherwise hang CI.
		timeout: 10_000,
	});
	if (result.status === null) {
		throw new Error(
			`cli did not exit (${result.signal ?? result.error?.message}): ${result.stderr}`,
		);
	}
	return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("cli progress", () => {
	// Exercise the real CLI, runner and renderer without a network or keys.
	const source = `
		import { rpc, SorobanDataBuilder, xdr } from ${JSON.stringify(import.meta.resolve("@stellar/stellar-sdk"))};
		rpc.Server.prototype.getContractInstance = async () => ({ executable: xdr.ContractExecutable.contractExecutableStellarAsset() });
		rpc.Server.prototype.getLedgerEntry = async () => ({ val: { type: "account", account: { seqNum: 1n } } });
		rpc.Server.prototype.simulateTransaction = async (tx) => ({
			_parsed: true, latestLedger: 100, events: [], transactionData: new SorobanDataBuilder(),
			result: { retval: tx.operations[0].func.invokeContract.functionName.toString() === "decimals" ? xdr.ScVal.scvU32(7) : xdr.ScVal.scvVoid() },
		});
		if (process.env.TEST_TTY) Object.defineProperty(process.stderr, "isTTY", { value: true });
	`;
	const preload = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
	const args = [CONTRACT, "--format", "json"];

	it("keeps piped stderr quiet by default", () => {
		const { code, out, err } = run(args, {}, preload);
		expect(JSON.parse(out)).toMatchObject({
			exitCode: code,
			summary: { total: 16 },
		});
		expect(err).toBe("");
	});

	it("prints plain progress on stderr with --progress and leaves stdout as JSON", () => {
		const { code, out, err } = run([...args, "--progress"], {}, preload);
		const report = JSON.parse(out);
		expect(report).toMatchObject({
			schema: "soroban-guard/report@1",
			exitCode: code,
		});
		expect(report.results[0].id).toBe("sep41-decimals");
		const rows = err.split("\n").filter((row) => row.startsWith("["));
		expect(rows).toHaveLength(16);
		expect(rows[0]).toMatch(/^\[ 1\/16\] decimals +\(\d+\.\d+s\) {2}PASS$/);
		expect(rows[1]).toMatch(/^\[ 2\/16\] balance +\(\d+\.\d+s\) {2}FAIL$/);
		expect(rows[15]).toMatch(/^\[16\/16\] transfer_from-expired /);
		expect(new Set(rows.map((row) => row.lastIndexOf(" "))).size).toBe(1);
		expect(err).not.toContain("sep41-");
		expect(err).not.toContain("\u001B");
	});

	it("shows a live line with terminal stderr and accepts --no-progress", () => {
		const env = { TEST_TTY: "1" };
		const interactive = run(args, env, preload);
		expect(JSON.parse(interactive.out).summary.total).toBe(16);
		expect(interactive.err).toContain("\r\u001B[2K0/16 complete");
		expect(run([...args, "--no-progress"], env, preload).err).toBe("");
	});

	it("colors only the trailing verdict on terminal stderr", () => {
		const { out, err } = run(args, { TEST_TTY: "1" }, preload);
		const rows = err.replaceAll("\r\u001B[2K", "\n").split("\n");
		expect(
			rows.find((row) => row.startsWith("[ 1/16]"))?.split("\u001B"),
		).toEqual([
			expect.stringMatching(/^\[ 1\/16\] decimals +\(\d+\.\d+s\) {2}$/),
			"[32mPASS",
			"[0m",
		]);
		expect(
			rows.find((row) => row.startsWith("[ 2/16]"))?.split("\u001B"),
		).toEqual([
			expect.stringMatching(/^\[ 2\/16\] balance +\(\d+\.\d+s\) {2}$/),
			"[31mFAIL",
			"[0m",
		]);
		expect(out).not.toContain("\u001B");
	});

	it.each([
		["NO_COLOR", [], { NO_COLOR: "" }],
		["--no-color", ["--no-color"], {}],
	] as const)("keeps progress verdicts plain with %s", (_case, flags, env) => {
		const { err } = run(
			[...args, ...flags],
			{ ...env, TEST_TTY: "1" },
			preload,
		);
		expect(err).toMatch(/\[ 1\/16\] decimals +\(\d+\.\d+s\) {2}PASS\n/);
		expect(err).not.toContain("\u001B[32m");
	});
});

describe("cli arguments", () => {
	it("prints the manifest version and exits 0 for --version", () => {
		const { code, out } = run(["--version"]);
		expect(code).toBe(0);
		expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("prints the version even alongside a contract id", () => {
		const { code, out } = run(["--version", CONTRACT]);
		expect(code).toBe(0);
		expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("prints usage and exits 0 for --help", () => {
		const { code, out } = run(["--help"]);
		expect(code).toBe(0);
		expect(out).toMatch(/^usage: soroban-guard <contract-id>/);
	});

	it("exits 2 with usage when no contract is given", () => {
		const { code, err } = run([]);
		expect(code).toBe(2);
		expect(err).toMatch(/usage:/);
	});

	it("exits 2 for a second positional", () => {
		expect(run([CONTRACT, "extra"]).code).toBe(2);
	});

	// `--help extra-garbage` once slipped through as a help request.
	it("treats --help with a positional as a usage error", () => {
		expect(run(["--help", CONTRACT]).code).toBe(2);
	});

	it("exits 2 for an unknown flag", () => {
		const { code, err } = run([CONTRACT, "--colour"]);
		expect(code).toBe(2);
		expect(err).toMatch(/invalid arguments/);
	});

	// Strkey carries a checksum: C and 55 As has the right shape and is
	// still not a contract id.
	it("rejects a contract id that fails its checksum", () => {
		const { code, err } = run([`C${"A".repeat(55)}`]);
		expect(code).toBe(2);
		expect(err).toMatch(/invalid contract ID/);
	});

	it("rejects an unknown --format, naming the valid ones", () => {
		const { code, err } = run([CONTRACT, "--format", "xml"]);
		expect(code).toBe(2);
		expect(err).toMatch(/invalid --format: xml \(expected text, md, json\)/);
	});

	it("rejects an RPC URL that does not parse", () => {
		const { code, err } = run([CONTRACT, "--rpc-url", "not a url"]);
		expect(code).toBe(2);
		expect(err).toMatch(/invalid RPC URL/);
	});

	// A blank passphrase must not fall back to testnet: that would switch
	// networks silently.
	it("refuses a blank passphrase", () => {
		const { code, err } = run([CONTRACT, "--passphrase", "  "]);
		expect(code).toBe(2);
		expect(err).toMatch(/passphrase must not be blank/);
	});
});

describe("cli environment", () => {
	it("uses SOROBAN_RPC_URL when no flag is given", () => {
		const { code, err } = run([CONTRACT], { SOROBAN_RPC_URL: "not a url" });
		expect(code).toBe(2);
		expect(err).toMatch(/invalid RPC URL: not a url/);
	});

	// The flag wins: the error names the flag's value, not the env's.
	it("prefers --rpc-url over SOROBAN_RPC_URL", () => {
		const { code, err } = run([CONTRACT, "--rpc-url", "flag value"], {
			SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
		});
		expect(code).toBe(2);
		expect(err).toMatch(/invalid RPC URL: flag value/);
	});
});

describe.each(["OWNER", "SPENDER"])("cli %s keys", (role) => {
	it("rejects an invalid secret without echoing it", () => {
		const secret = "SNOTAREALSECRETKEY";
		const { code, err } = run([CONTRACT], { [`${role}_SECRET`]: secret });
		expect(code).toBe(2);
		expect(err).toMatch(new RegExp(`invalid ${role}_SECRET`));
		expect(err).not.toContain(secret);
	});

	it("rejects an invalid address", () => {
		const { code, err } = run([CONTRACT], { [`${role}_ADDRESS`]: "GBAD" });
		expect(code).toBe(2);
		expect(err).toMatch(new RegExp(`invalid ${role}_ADDRESS: GBAD`));
	});

	// Reading one account and signing as another would FAIL the contract
	// for a misconfiguration.
	it("refuses a secret that does not match its address", () => {
		const { code, err } = run([CONTRACT], {
			[`${role}_SECRET`]: Keypair.random().secret(),
			[`${role}_ADDRESS`]: Keypair.random().publicKey(),
		});
		expect(code).toBe(2);
		expect(err).toMatch(
			new RegExp(`${role}_SECRET is the key for G[A-Z2-7]{55}, but`),
		);
	});
});

describe("cli write consent", () => {
	it("refuses to sign on mainnet without the override", () => {
		const { code, err } = run(
			[
				CONTRACT,
				"--passphrase",
				Networks.PUBLIC,
				"--rpc-url",
				"https://rpc.example.invalid",
			],
			{ OWNER_SECRET: Keypair.random().secret() },
		);
		expect(code).toBe(2);
		expect(err).toMatch(/refusing to sign on .*testnet-only/);
	});

	it("refuses a passphrase that does not match a known RPC host", () => {
		const { code, err } = run([CONTRACT, "--passphrase", Networks.FUTURENET], {
			OWNER_SECRET: Keypair.random().secret(),
		});
		expect(code).toBe(2);
		expect(err).toMatch(/network mismatch: soroban-testnet\.stellar\.org/);
	});
});
