import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wallet adapter, against a stubbed Freighter.
 *
 * Every case here is a way the extension answers without an error and
 * still hands back nothing usable: a dismissed dialog, a missing network,
 * an empty signature, a different account. Each must stop the run as a
 * wallet problem, not flow onward and surface as a contract fault.
 */
const api = vi.hoisted(() => ({
	isConnected: vi.fn(),
	requestAccess: vi.fn(),
	getNetwork: vi.fn(),
	signTransaction: vi.fn(),
	signAuthEntry: vi.fn(),
}));

vi.mock("@stellar/freighter-api", () => api);

const OWNER = "GDMEI62DG7T56E2CRGHQBK66ZT73ITHV5VMNCUZUQLO53RHUAPVDGCDU";
const OTHER = "GBXXZ4J2GYOVHBVSLCHN5GBTJ3GIBKTR4W5ZZTF6SZ7XE6EIJ3YPSHJB";
const PASSPHRASE = "Test SDF Network ; September 2015";

// Fresh module per test: `isFreighterInstalled` remembers a positive probe.
async function load() {
	vi.resetModules();
	return import("../src/scripts/freighter.ts");
}

beforeEach(() => {
	for (const fn of Object.values(api)) {
		fn.mockReset();
	}
});

describe("isFreighterInstalled", () => {
	it("keeps asking when a sleeping extension misses the first probe", async () => {
		api.isConnected
			.mockResolvedValueOnce({ isConnected: false })
			.mockResolvedValueOnce({ isConnected: true });
		const { isFreighterInstalled } = await load();
		expect(await isFreighterInstalled()).toBe(true);
		expect(api.isConnected).toHaveBeenCalledTimes(2);
	});

	it("reports absent after three silent probes", async () => {
		api.isConnected.mockResolvedValue({ isConnected: false });
		const { isFreighterInstalled } = await load();
		expect(await isFreighterInstalled()).toBe(false);
		expect(api.isConnected).toHaveBeenCalledTimes(3);
	});

	it("does not probe again once the extension has answered", async () => {
		api.isConnected.mockResolvedValue({ isConnected: true });
		const { isFreighterInstalled } = await load();
		await isFreighterInstalled();
		await isFreighterInstalled();
		expect(api.isConnected).toHaveBeenCalledTimes(1);
	});
});

describe("connect", () => {
	it("returns the granted address", async () => {
		api.isConnected.mockResolvedValue({ isConnected: true });
		api.requestAccess.mockResolvedValue({ address: OWNER });
		const { connect } = await load();
		expect(await connect()).toBe(OWNER);
	});

	it("names a dismissed dialog rather than passing on an empty address", async () => {
		api.isConnected.mockResolvedValue({ isConnected: true });
		api.requestAccess.mockResolvedValue({ address: "" });
		const { connect, WalletError } = await load();
		await expect(connect()).rejects.toBeInstanceOf(WalletError);
	});

	it("shows Freighter's message, not [object Object]", async () => {
		api.isConnected.mockResolvedValue({ isConnected: true });
		api.requestAccess.mockResolvedValue({
			address: "",
			error: { code: -4, message: "The user rejected this request." },
		});
		const { connect } = await load();
		await expect(connect()).rejects.toThrow("The user rejected this request.");
	});
});

describe("walletNetwork", () => {
	it("refuses a network with no passphrase", async () => {
		api.getNetwork.mockResolvedValue({
			network: "TESTNET",
			networkPassphrase: null,
		});
		const { walletNetwork, WalletError } = await load();
		await expect(walletNetwork()).rejects.toBeInstanceOf(WalletError);
	});
});

describe("freighterSigner", () => {
	it("passes a signature from the connected account through", async () => {
		api.signTransaction.mockResolvedValue({
			signedTxXdr: "AAAA",
			signerAddress: OWNER,
		});
		const { freighterSigner } = await load();
		const signed = await freighterSigner(OWNER, PASSPHRASE).signTransaction(
			"x",
		);
		expect(signed.signedTxXdr).toBe("AAAA");
	});

	it("refuses an empty signed transaction", async () => {
		api.signTransaction.mockResolvedValue({
			signedTxXdr: "",
			signerAddress: OWNER,
		});
		const { freighterSigner, WalletError } = await load();
		await expect(
			freighterSigner(OWNER, PASSPHRASE).signTransaction("x"),
		).rejects.toBeInstanceOf(WalletError);
	});

	it("refuses a null authorization entry", async () => {
		api.signAuthEntry.mockResolvedValue({
			signedAuthEntry: null,
			signerAddress: OWNER,
		});
		const { freighterSigner, WalletError } = await load();
		await expect(
			freighterSigner(OWNER, PASSPHRASE).signAuthEntry("x"),
		).rejects.toBeInstanceOf(WalletError);
	});

	// The case that matters most: a run measured against one account and
	// signed, part-way through, by another.
	it.each([
		[
			"signTransaction",
			() =>
				api.signTransaction.mockResolvedValue({
					signedTxXdr: "AAAA",
					signerAddress: OTHER,
				}),
		],
		[
			"signAuthEntry",
			() =>
				api.signAuthEntry.mockResolvedValue({
					signedAuthEntry: "AAAA",
					signerAddress: OTHER,
				}),
		],
	] as const)(
		"%s refuses a signature from a switched account",
		async (method, stub) => {
			stub();
			const { freighterSigner } = await load();
			await expect(
				freighterSigner(OWNER, PASSPHRASE)[method]("x"),
			).rejects.toThrow(`Freighter signed as ${OTHER}`);
		},
	);
});
