import { contract, type rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { inspectContract, specFunctionNames } from "../../../src/core/spec.ts";

function entry(name: string): xdr.ScSpecEntry {
	return xdr.ScSpecEntry.scSpecEntryFunctionV0(
		new xdr.ScSpecFunctionV0({ doc: "", name, inputs: [], outputs: [] }),
	);
}

function stubServer(
	overrides: Partial<Record<"getContractInstance", () => Promise<never>>>,
): rpc.Server {
	return {
		getContractInstance: async () => {
			throw { code: 404 };
		},
		...overrides,
	} as unknown as rpc.Server;
}

describe("specFunctionNames", () => {
	it("lists declared functions through the real SDK parser", () => {
		const spec = new contract.Spec([entry("decimals"), entry("balance")]);
		expect(specFunctionNames(spec)).toEqual(["decimals", "balance"]);
	});
});

describe("inspectContract", () => {
	it("reports missing when the instance fetch 404s", async () => {
		const server = stubServer({});
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).resolves.toEqual({ kind: "missing" });
	});

	it("propagates transport failures instead of misreporting", async () => {
		const server = stubServer({
			getContractInstance: async () => {
				throw new TypeError("fetch failed");
			},
		});
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).rejects.toThrow("fetch failed");
	});

	it("reports native for contracts without WASM (SAC)", async () => {
		const server = {
			getContractInstance: async () => ({
				executable: { type: "contractExecutableStellarAsset" },
			}),
		} as unknown as rpc.Server;
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).resolves.toEqual({ kind: "native" });
	});

	it("reports missing on message-shaped not-found errors too", async () => {
		const server = stubServer({
			getContractInstance: async () => {
				throw new Error("Could not obtain contract instance from server");
			},
		});
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).resolves.toEqual({ kind: "missing" });
	});

	it("propagates transport failures from the code fetch", async () => {
		const server = {
			getContractInstance: async () => ({
				executable: {
					type: "contractExecutableWasm",
					value: { value: new Uint8Array([1, 2, 3]) },
				},
			}),
			getContractWasmByHash: async () => {
				throw new TypeError("fetch failed");
			},
		} as unknown as rpc.Server;
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).rejects.toThrow("fetch failed");
	});

	it("falls back to native when code is unfetchable", async () => {
		// The hash must be a real Uint8Array: without it the shape guard
		// returns native before the fetch, and this test would pass without
		// ever reaching the 404 branch it is named for.
		let fetched = false;
		const server = {
			getContractInstance: async () => ({
				executable: {
					type: "contractExecutableWasm",
					value: { value: new Uint8Array([1, 2, 3]) },
				},
			}),
			getContractWasmByHash: async () => {
				fetched = true;
				throw { code: 404 };
			},
		} as unknown as rpc.Server;
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).resolves.toEqual({ kind: "native" });
		expect(fetched).toBe(true);
	});

	it("does not mistake unrelated Not Found messages for missing", async () => {
		const server = stubServer({
			getContractInstance: async () => {
				throw new Error("LB Request failed with status 404: Not Found");
			},
		});
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).rejects.toThrow("LB Request failed with status 404: Not Found");
	});

	it("falls back to native on a null external ref without calling out", async () => {
		const server = {
			getContractInstance: async () => ({
				executable: {
					type: "contractExecutableExternalRef",
					externalRef: null,
				},
			}),
			getExternalRefWasmHash: vi.fn(async () => new Uint8Array([9])),
		} as unknown as rpc.Server & {
			getExternalRefWasmHash: ReturnType<typeof vi.fn>;
		};
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).resolves.toEqual({ kind: "native" });
		expect(server.getExternalRefWasmHash).not.toHaveBeenCalled();
	});

	it("falls back to native when an external ref is unresolvable", async () => {
		const server = {
			getContractInstance: async () => ({
				executable: {
					type: "contractExecutableExternalRef",
					externalRef: {},
				},
			}),
			getExternalRefWasmHash: vi.fn(async () => {
				throw { code: 404 };
			}),
		} as unknown as rpc.Server & {
			getExternalRefWasmHash: ReturnType<typeof vi.fn>;
		};
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).resolves.toEqual({ kind: "native" });
		expect(server.getExternalRefWasmHash).toHaveBeenCalledTimes(1);
	});

	it("falls back to native on malformed external refs", async () => {
		const server = {
			getContractInstance: async () => ({
				executable: {
					type: "contractExecutableExternalRef",
					externalRef: {},
				},
			}),
			getExternalRefWasmHash: async () => {
				throw { code: 400 };
			},
		} as unknown as rpc.Server;
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).resolves.toEqual({ kind: "native" });
	});

	it("propagates transport failures from external-ref resolution", async () => {
		const server = {
			getContractInstance: async () => ({
				executable: {
					type: "contractExecutableExternalRef",
					externalRef: {},
				},
			}),
			getExternalRefWasmHash: async () => {
				throw new TypeError("fetch failed");
			},
		} as unknown as rpc.Server;
		await expect(
			inspectContract(
				server,
				"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
			),
		).rejects.toThrow("fetch failed");
	});

	// The wasm-happy-path (real bytes → declared names) cannot run offline:
	// no WASM fixture exists in-tree. It is proven live when OZ-token
	// validation lands (SOW-scheduled), which exercises a real WASM token.
});

/**
 * Code the network serves but the SDK's spec parser refuses. Losing the
 * spec only loses the NOT_IMPLEMENTED shortcut (every member is then
 * attempted), so both ways of reaching the code must fall back to native.
 * A parser error on either path is not a transport failure.
 */
describe("inspectContract with code whose spec cannot be read", () => {
	const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
	const specName = [..."contractspecv0"].map((c) => c.charCodeAt(0));
	const specSection = [0x00, specName.length + 1, specName.length, ...specName];
	const unreadable = {
		// "Could not obtain contract spec from wasm"
		"has no spec section": new Uint8Array(HEADER),
		// SDK 17.3+: "Expected at most one 'contractspecv0' section"
		"has two spec sections": new Uint8Array([
			...HEADER,
			...specSection,
			...specSection,
		]),
	};
	const ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

	it.each(Object.entries(unreadable))(
		"falls back to native when WASM code %s",
		async (_label, wasm) => {
			const server = {
				getContractInstance: async () => ({
					executable: {
						type: "contractExecutableWasm",
						value: { value: new Uint8Array([1, 2, 3]) },
					},
				}),
				getContractWasmByHash: async () => wasm,
			} as unknown as rpc.Server;
			await expect(inspectContract(server, ID)).resolves.toEqual({
				kind: "native",
			});
		},
	);

	it.each(Object.entries(unreadable))(
		"falls back to native when external-ref code %s",
		async (_label, wasm) => {
			const server = {
				getContractInstance: async () => ({
					executable: {
						type: "contractExecutableExternalRef",
						externalRef: {},
					},
				}),
				getExternalRefWasmHash: async () => new Uint8Array([9]),
				getContractWasmByHash: async () => wasm,
			} as unknown as rpc.Server;
			await expect(inspectContract(server, ID)).resolves.toEqual({
				kind: "native",
			});
		},
	);

	// The fallback is for code the parser refuses, not for a network that
	// failed to deliver it: a transport error still stops the run.
	it("still propagates a transport failure fetching external-ref code", async () => {
		const server = {
			getContractInstance: async () => ({
				executable: {
					type: "contractExecutableExternalRef",
					externalRef: {},
				},
			}),
			getExternalRefWasmHash: async () => new Uint8Array([9]),
			getContractWasmByHash: async () => {
				throw new TypeError("fetch failed");
			},
		} as unknown as rpc.Server;
		await expect(inspectContract(server, ID)).rejects.toThrow("fetch failed");
	});
});
