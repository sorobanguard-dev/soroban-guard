import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

/**
 * The CLI as a user meets it: a process, its arguments, its environment,
 * its exit code. Every path here exits before the first network call, so
 * the suite stays offline — the refusals are the contract a script calling
 * `soroban-guard` in CI depends on, and exit 2 is how it tells "you called
 * me wrong" apart from exit 1, "the contract failed".
 */
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const CONTRACT = "CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54";

function run(args: string[], env: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, [CLI, ...args], {
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

describe("cli arguments", () => {
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
