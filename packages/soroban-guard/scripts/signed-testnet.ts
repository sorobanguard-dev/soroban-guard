import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	Asset,
	BASE_FEE,
	Keypair,
	Operation,
	rpc,
	type Transaction,
	TransactionBuilder,
} from "@stellar/stellar-sdk";
import { TESTNET_PASSPHRASE } from "../src/core/consent.ts";
import { fundAccount, loadSourceAccount } from "../src/core/funding.ts";
import { declined, RPC_TIMEOUT_MS, sendAndFollow } from "../src/core/invoke.ts";
import { validateSignedTestnetReport } from "./signed-testnet-report.ts";

const RPC_URL = "https://soroban-testnet.stellar.org";
const TX_OPTIONS = { fee: BASE_FEE, networkPassphrase: TESTNET_PASSPHRASE };

async function settleSetup(
	server: rpc.Server,
	transaction: Transaction,
	ledger: number,
	step: string,
): Promise<void> {
	const outcome = await sendAndFollow(server, transaction, {
		transaction,
		ledger,
	});
	if (outcome.kind !== "applied") {
		const reason =
			outcome.kind === "not-accepted" ? declined(outcome) : outcome.kind;
		throw new Error(
			`${step} did not apply (${reason}). Transaction ${outcome.txHash}.`,
		);
	}
	console.log(`${step} settled in ledger ${outcome.ledger}.`);
}

async function provision(server: rpc.Server, owner: Keypair, spender: Keypair) {
	const issuer = Keypair.random();
	const asset = new Asset("SGTEST", issuer.publicKey());
	console.log("Funding disposable Testnet issuer, holder, and spender.");
	for (const key of [issuer, owner, spender]) {
		await fundAccount(server, key.publicKey());
	}

	const issuerAccount = await loadSourceAccount(server, issuer.publicKey());
	const deployment = new TransactionBuilder(issuerAccount, TX_OPTIONS)
		.addOperation(Operation.createStellarAssetContract({ asset }))
		.setTimeout(60)
		.build();
	const simulation = await server.simulateTransaction(deployment);
	if (!rpc.Api.isSimulationSuccess(simulation)) {
		const reason = rpc.Api.isSimulationError(simulation)
			? simulation.error
			: "unexpected simulation response";
		throw new Error(
			`Stellar Asset Contract deployment could not be simulated (${reason}).`,
		);
	}
	const prepared = rpc.assembleTransaction(deployment, simulation).build();
	prepared.sign(issuer);
	await settleSetup(
		server,
		prepared,
		simulation.latestLedger,
		"Asset contract deployment",
	);

	const ownerAccount = await loadSourceAccount(server, owner.publicKey());
	const { sequence } = await server.getLatestLedger();
	const setup = new TransactionBuilder(ownerAccount, TX_OPTIONS)
		.addOperation(Operation.changeTrust({ line: asset }))
		.addOperation(
			Operation.changeTrust({ line: asset, source: spender.publicKey() }),
		)
		.addOperation(
			Operation.payment({
				source: issuer.publicKey(),
				destination: owner.publicKey(),
				asset,
				amount: "100",
			}),
		)
		.setTimeout(60)
		.build();
	setup.sign(owner, spender, issuer);
	await settleSetup(server, setup, sequence, "Trustlines and initial balance");
	return asset.contractId(TESTNET_PASSPHRASE);
}

const [, , cli, directory] = process.argv;
if (cli === undefined || directory === undefined) {
	throw new Error(
		"Usage: node scripts/signed-testnet.ts <cli-path> <output-directory>",
	);
}
mkdirSync(directory);
const server = new rpc.Server(RPC_URL, { timeout: RPC_TIMEOUT_MS });
const owner = Keypair.random();
const spender = Keypair.random();
const contractId = await provision(server, owner, spender);
console.log(`Checking ${contractId} on Testnet.`);

const reportPath = resolve(directory, "report.json");
const reportFile = openSync(reportPath, "wx");
try {
	const run = spawnSync(
		process.execPath,
		[
			resolve(cli),
			contractId,
			"--format",
			"json",
			"--progress",
			"--rpc-url",
			RPC_URL,
			"--passphrase",
			TESTNET_PASSPHRASE,
		],
		{
			env: { OWNER_SECRET: owner.secret(), SPENDER_SECRET: spender.secret() },
			stdio: ["ignore", reportFile, "inherit"],
			timeout: 8 * 60 * 1000,
		},
	);
	if (run.error !== undefined) {
		throw run.error;
	}
	const report: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
	const passed = validateSignedTestnetReport(report, contractId, run.status);
	console.log(
		`${passed}/${passed} checks passed. Report saved to ${reportPath}.`,
	);
} finally {
	closeSync(reportFile);
}
