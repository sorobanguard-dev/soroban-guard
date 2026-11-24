import {
	Address,
	Contract,
	Keypair,
	nativeToScVal,
	rpc,
	TransactionBuilder,
	type xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { interpretSimulation } from "../../../src/core/invoke.ts";
import { classifySimulationFailure } from "../../../src/core/simulation.ts";
import {
	classifyStanding,
	isNativeAssetRefusal,
} from "../../../src/sep41/checks/shared.ts";

/**
 * The classifier against what testnet returns today, so a change in the
 * RPC's or the SDK's shape of a failed simulation cannot pass unnoticed.
 * Simulation only: nothing is signed or sent, so no keys are needed.
 */
const RPC =
	process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE =
	process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

/** Testnet accounts that exist; only their sequence numbers are read. */
const FROM = "GDMEI62DG7T56E2CRGHQBK66ZT73ITHV5VMNCUZUQLO53RHUAPVDGCDU";
const TO = "GDS6R6VS3OTSWVVYS6G5XXO3QBW5BBIAKQGCMA44PWNLCWY2SVGWCC25";
const SET = "CDABMBRIDJKHHNYHEQLE3GEINB5EKHGW62SDEXEOKNPKUF2MEJQVYLV5";
const TEST = "CARQGEM3RDSWA2SRZDL6LDBOEQWQHS74BOL5V62QXIGMOBIMIX5YTYYN";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

async function failing(
	contractId: string,
	method: string,
	args: xdr.ScVal[],
): Promise<rpc.Api.SimulateTransactionErrorResponse> {
	const server = new rpc.Server(RPC);
	const tx = new TransactionBuilder(await server.getAccount(FROM), {
		fee: "100",
		networkPassphrase: PASSPHRASE,
	})
		.addOperation(new Contract(contractId).call(method, ...args))
		.setTimeout(30)
		.build();
	const sim = await server.simulateTransaction(tx);
	if (!rpc.Api.isSimulationError(sim)) {
		throw new Error(`expected ${contractId} to refuse ${method}`);
	}
	return sim;
}

function failedTransfer(contractId: string, amount: bigint) {
	return failing(contractId, "transfer", [
		new Address(FROM).toScVal(),
		new Address(TO).toScVal(),
		nativeToScVal(amount, { type: "i128" }),
	]);
}

describe("classifySimulationFailure, on testnet", () => {
	// SET refuses by panicking: the evidence is in the events alone.
	it("credits SET's trap in transfer as the contract refusing", async () => {
		expect(classifySimulationFailure(await failedTransfer(SET, -1n))).toEqual({
			byContract: true,
			error: "Error(WasmVm, InvalidAction)",
			reason: "VM call trapped: UnreachableCodeReached",
		});
	}, 30_000);

	// The Stellar Asset Contract refuses with its own contract errors.
	it("credits the TEST asset contract's error as the contract refusing", async () => {
		expect(
			classifySimulationFailure(await failedTransfer(TEST, 10n ** 30n)),
		).toMatchObject({
			byContract: true,
			error: expect.stringMatching(/^Error\(Contract, #[0-9]+\)$/),
		});
	}, 30_000);

	// The asset's reason arrives in its error event alone; a read must still
	// recognise it as standing rather than FAIL the contract.
	it("recognises a missing trustline in what a balance read returns", async () => {
		const nobody = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
		const outcome = interpretSimulation(
			await failing(TEST, "balance", [new Address(nobody).toScVal()]),
		);
		expect(outcome).toMatchObject({
			kind: "trapped",
			reason: "trustline entry is missing for account",
		});
		expect(classifyStanding(outcome.kind === "trapped" ? outcome : {})).toBe(
			"no-trustline",
		);
	}, 30_000);

	// The native asset contract's refusal to burn keeps its wording too.
	it("recognises the native asset's refusal to burn", async () => {
		const outcome = interpretSimulation(
			await failing(XLM, "burn", [
				new Address(FROM).toScVal(),
				nativeToScVal(1n, { type: "i128" }),
			]),
		);
		expect(outcome.kind).toBe("trapped");
		expect(
			isNativeAssetRefusal(outcome.kind === "trapped" ? outcome : {}),
		).toBe(true);
	}, 30_000);
});
