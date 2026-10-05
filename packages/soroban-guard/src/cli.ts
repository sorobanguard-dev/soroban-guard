#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Account, Keypair, rpc, StrKey } from "@stellar/stellar-sdk";
import { KeypairSigner } from "@stellar/stellar-sdk/contract";
import { supportsColor } from "./core/ansi.ts";
import { TESTNET_PASSPHRASE, writeRefusalReason } from "./core/consent.ts";
import { fundAccount, loadSourceAccount } from "./core/funding.ts";
import { renderJsonReport } from "./core/json-report.ts";
import { renderMarkdownReport } from "./core/md-report.ts";
import { renderPretty } from "./core/pretty.ts";
import { exitCodeFor, publicRpcUrl, renderReport } from "./core/report.ts";
import { runSuite } from "./core/runner.ts";
import { inspectContract } from "./core/spec.ts";
import type { CheckResult } from "./core/types.ts";
import type { Party, Sep41Context } from "./sep41/context.ts";
import { sep41Suite, withCoverageGaps } from "./sep41/index.ts";

const USAGE =
	"usage: soroban-guard <contract-id> [--rpc-url URL] [--passphrase P] [--format text|md|json] [--no-color] [--allow-http] [--allow-non-testnet-write] [--version]";

/**
 * The version in the manifest next to this file — `package.json` sits
 * beside both `src/cli.ts` and the compiled `dist/cli.js`, so one relative
 * path serves development and the published binary alike.
 */
function packageVersion(): string {
	try {
		const manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version?: unknown };
		if (typeof manifest.version === "string" && manifest.version !== "") {
			return manifest.version;
		}
	} catch {
		// Fall through to unknown below: a version command must never fail
		// because metadata is unreadable.
	}
	return "unknown";
}

const FORMATS = ["text", "md", "json"] as const;
type Format = (typeof FORMATS)[number];

function isFormat(value: string): value is Format {
	return (FORMATS as readonly string[]).includes(value);
}

let positionals: string[];
let values: {
	"rpc-url"?: string;
	passphrase?: string;
	format?: string;
	"no-color"?: boolean;
	"allow-http"?: boolean;
	"allow-non-testnet-write"?: boolean;
	help?: boolean;
	version?: boolean;
};
try {
	({ positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			"rpc-url": { type: "string" },
			passphrase: { type: "string" },
			format: { type: "string" },
			"no-color": { type: "boolean" },
			"allow-http": { type: "boolean" },
			"allow-non-testnet-write": { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "V" },
		},
	}));
} catch (error) {
	console.error(
		`invalid arguments: ${error instanceof Error ? error.message : String(error)}`,
	);
	console.error(USAGE);
	process.exit(2);
}

const [rawContractId, ...extraPositionals] = positionals;
// Lenient unlike --help: every major CLI prints its version regardless of
// what else was passed, and a version probe must not become a usage error.
if (values.version) {
	console.log(packageVersion());
	process.exit(0);
}
// Any positional alongside --help is a usage error, not a help request:
// `--help extra-garbage` used to slip through because only 2+
// positionals were rejected before the help branch.
if (extraPositionals.length > 0 || (values.help && positionals.length > 0)) {
	console.error(USAGE);
	process.exit(2);
}
if (values.help) {
	console.log(USAGE);
	process.exit(0);
}
const contractId = nonEmpty(rawContractId);
if (!contractId) {
	console.error(USAGE);
	process.exit(2);
}
if (!StrKey.isValidContract(contractId)) {
	console.error(`invalid contract ID: ${contractId}`);
	process.exit(2);
}

/**
 * Resolve one role's address and, when this run holds the key, its signer.
 *
 * `<ROLE>_SECRET` is the stronger source: a secret key contains its own
 * public key, so it settles the address by itself. `<ROLE>_ADDRESS` alone
 * gives reads a real holder to observe while leaving writes UNVERIFIABLE.
 * Neither generates a throwaway — reads still observe something, writes
 * still report honestly.
 *
 * A secret that disagrees with a supplied address is a misconfiguration,
 * not a preference to resolve: reading one account's balance while signing
 * as another produces a FAIL that says nothing about the contract. So it
 * exits rather than picking a winner, the same way a blank passphrase does.
 */
function resolveRole(
	role: "OWNER" | "SPENDER",
	// A signer binds the network it signs for, so the passphrase is a
	// parameter rather than a closed-over const: the ordering constraint is
	// then visible in the signature instead of being a TDZ throw waiting for
	// whoever reorders CLI setup next.
	networkPassphrase: string,
): Party {
	const declared = nonEmpty(process.env[`${role}_ADDRESS`]);
	const secret = nonEmpty(process.env[`${role}_SECRET`]);
	if (declared !== undefined && !StrKey.isValidEd25519PublicKey(declared)) {
		console.error(`invalid ${role}_ADDRESS: ${declared}`);
		process.exit(2);
	}
	if (secret === undefined) {
		return {
			address: declared ?? Keypair.random().publicKey(),
			isThrowaway: declared === undefined,
		};
	}
	let keypair: Keypair;
	try {
		keypair = Keypair.fromSecret(secret);
	} catch {
		// Never echo the value — it is a private key.
		console.error(`invalid ${role}_SECRET: not a valid S... secret key`);
		process.exit(2);
	}
	const address = keypair.publicKey();
	if (declared !== undefined && declared !== address) {
		console.error(
			`${role}_SECRET is the key for ${address}, but ${role}_ADDRESS is ${declared}`,
		);
		process.exit(2);
	}
	return {
		address,
		// KeypairSigner is a Signer already — it carries the address it signs
		// as, so there is no pair of fields to keep in sync. The SDK's own
		// basicNodeSigner docs point here for exactly that reason.
		signer: new KeypairSigner(keypair, networkPassphrase),
		isThrowaway: false,
	};
}

/** Empty/blank flags behave as unset: `--rpc-url ""` must fall back to env
 * and defaults exactly like an omitted flag, not reach the SDK as "". */
function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * The passphrase is network identity, not a free string: never trim it
 * (trimming " X " into "X" would silently switch networks), and refuse a
 * blank one instead of falling back — silent defaults hide misconfig.
 */
function resolvePassphrase(value: string | undefined): string {
	if (value === undefined) {
		return TESTNET_PASSPHRASE;
	}
	if (value.trim() === "") {
		console.error("passphrase must not be blank");
		process.exit(2);
	}
	if (value !== value.trim()) {
		console.error("warning: passphrase has surrounding whitespace");
	}
	return value;
}

const rawFormat = nonEmpty(values.format) ?? "text";
if (!isFormat(rawFormat)) {
	console.error(
		`invalid --format: ${rawFormat} (expected ${FORMATS.join(", ")})`,
	);
	process.exit(2);
}
const format: Format = rawFormat;

const rpcUrl = (
	nonEmpty(values["rpc-url"]) ??
	nonEmpty(process.env.SOROBAN_RPC_URL) ??
	"https://soroban-testnet.stellar.org"
).replace(/\/+$/, "");
try {
	new URL(rpcUrl);
} catch {
	console.error(`invalid RPC URL: ${rpcUrl}`);
	process.exit(2);
}
// Redacted once, at the boundary: everything downstream (md committed to
// git, json travelling through CI artifacts) must only ever see the safe
// form, never the raw URL with its embedded keys.
const reportedRpcUrl = publicRpcUrl(rpcUrl);
const networkPassphrase = resolvePassphrase(
	values.passphrase ?? process.env.NETWORK_PASSPHRASE,
);

const parties = {
	owner: resolveRole("OWNER", networkPassphrase),
	spender: resolveRole("SPENDER", networkPassphrase),
};

/**
 * One render path for every output site — the early exits and the full run.
 *
 * `ranAt` is taken once rather than inside each renderer: the run has a
 * single timestamp, and a renderer that read the clock itself could not be
 * tested against a fixed expectation.
 */
const ranAt = new Date().toISOString();
// Rebound as a non-optional local: the `process.exit` above proves it is
// set, but that narrowing does not follow a `const` into a function body.
const target: string = contractId;
function render(results: readonly CheckResult[]): string {
	const common = {
		standard: sep41Suite.standard,
		contractId: target,
		results,
	};
	if (format === "json") {
		return renderJsonReport({ ...common, ranAt, rpcUrl: reportedRpcUrl });
	}
	if (format === "md") {
		return renderMarkdownReport({ ...common, ranAt, rpcUrl: reportedRpcUrl });
	}
	// Two different refusals, two different answers. `--no-color` and a
	// non-terminal stdout drop to the flat renderer, because a redirected
	// report should be one line per check for grep and diff. `NO_COLOR` does
	// not come through here: it reaches `supportsColor` below and yields the
	// grouped layout without escapes, which is what that standard asks for —
	// no colour, not a different report.
	if (values["no-color"] === true || !process.stdout.isTTY) {
		return renderReport(common);
	}
	return renderPretty({
		...common,
		color: supportsColor(process.stdout),
		width: process.stdout.columns ?? 100,
	});
}

const refusal = writeRefusalReason({
	willSign:
		parties.owner.signer !== undefined || parties.spender.signer !== undefined,
	passphrase: networkPassphrase,
	rpcHostname: new URL(rpcUrl).hostname,
	override: values["allow-non-testnet-write"] === true,
});
if (refusal !== null) {
	console.error(refusal);
	process.exit(2);
}

let server: rpc.Server;
let source: Account;
let specFunctions: readonly string[] | null;
try {
	// The SDK validates the transport scheme eagerly and throws outside any
	// RPC call, so construction lives inside the guarded block too.
	// Order inside is deliberate: inspect first, so a missing ID exits
	// before spending faucet quota or waiting out polls; fund next
	// (check-first, owner only: it sources and signs every call, and an
	// untouched funded account costs nothing); load last, so a
	// post-funding load failure genuinely means unreachable.
	server = new rpc.Server(rpcUrl, {
		allowHttp: values["allow-http"] === true,
	});
	const inspected = await inspectContract(server, contractId);
	if (inspected.kind === "missing") {
		console.error(`no contract found at ${contractId}`);
		console.log(render([]));
		process.exit(2);
	}
	specFunctions = inspected.kind === "wasm" ? inspected.functions : null;
	// Fund whoever signs, because a transaction is sourced from its signer
	// and needs that account to exist and hold fees. The owner always does;
	// the spender does only when it holds a key, and an address that merely
	// receives needs nothing — so the second is conditional rather than
	// unconditional faucet spend.
	//
	// Four checks submit as the spender: transfer_from, burn_from, and the
	// two that attempt a spend the contract should refuse. Without funding,
	// a fresh SPENDER_SECRET makes all four throw and report SKIPPED, which
	// reads as "unknown" instead of the assessment that was asked for.
	await fundAccount(server, parties.owner.address);
	if (parties.spender.signer !== undefined) {
		await fundAccount(server, parties.spender.address);
	}
	source = await loadSourceAccount(server, parties.owner.address);
} catch (error) {
	console.error(
		`cannot prepare run: ${error instanceof Error ? error.message : String(error)}`,
	);
	console.log(render([]));
	process.exit(2);
}
const ctx: Sep41Context = {
	server,
	contractId,
	source,
	networkPassphrase,
	specFunctions,
	parties,
	// Fresh per run: grants established by earlier checks are fresh by
	// construction, which is the only expiry proof allowance() can give.
	establishedAllowances: new Set(),
	// Fresh per run: what one contract's accounting did says nothing about
	// the next one's.
	soundness: {},
};

const assessed = await runSuite(sep41Suite, ctx);
// Unassessed members become UNVERIFIABLE rows: without this, a suite that
// passes every check it happens to own would exit 0 — "verified conformant"
// — while the members it never examined went unreported.
const results = withCoverageGaps(assessed);
console.log(render(results));
// 0 = verified conformant, 1 = verified violation, 2 = unknown (see
// exitCodeFor). SKIPPED/UNVERIFIABLE are not contract verdicts and must
// never exit 1.
process.exit(exitCodeFor(results));
