import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_CONTRACT } from "../src/data/demo.ts";
import type { Cleanup, RunOutcome } from "../src/scripts/run.ts";

/**
 * The page's own handlers, clicked in order: what the next request is held
 * to after a status check or a faucet claim, and what happens to the
 * temporary account's key when Run is pressed with a cleanup still owed.
 * The page script reads its elements on import, so each test builds a
 * document of stand-ins first; the wallet and the network are stubbed one
 * layer down, in `run.ts` and `freighter.ts`.
 */
vi.mock("../src/scripts/freighter.ts", () => ({
	connect: vi.fn(async () => WALLET),
	isFreighterInstalled: vi.fn(async () => true),
	walletNetwork: vi.fn(async () => ({
		network: "TESTNET",
		networkPassphrase: "Test SDF Network ; September 2015",
	})),
	freighterSigner: vi.fn(),
	WalletError: class extends Error {},
}));
vi.mock("../src/scripts/run.ts", async (importActual) => ({
	...(await importActual<typeof import("../src/scripts/run.ts")>()),
	runChecks: vi.fn(),
	tokenBalance: vi.fn(),
	claimDemoTokens: vi.fn(),
	claimStatus: vi.fn(),
	spendableXlm: vi.fn(),
}));

const WALLET = "GAFD36WZNOJ4NBHB25QL6XRU2OYNIQC3IEUAXPIQ7FVDYLJE5H5ZVQ5G";
const HASH = "ef".repeat(32);

/** An element as far as the page script uses one. */
class Stand {
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, ((event: unknown) => unknown)[]>();
	readonly dataset: Record<string, string> = {};
	children: unknown[] = [];
	disabled = false;
	hidden = false;
	value = "";
	className = "";
	type = "";
	id = "";
	title = "";
	href = "";
	rel = "";
	target = "";
	#text = "";
	get textContent(): string {
		return this.#text;
	}
	/** As in the DOM, setting the text replaces the children. */
	set textContent(text: string) {
		this.#text = text;
		this.children = [];
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
	addEventListener(type: string, listener: (event: unknown) => unknown): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	dispatchEvent(event: { type: string }): boolean {
		for (const listener of this.listeners.get(event.type) ?? []) {
			void listener(event);
		}
		return true;
	}
	append(...nodes: unknown[]): void {
		this.children.push(...nodes);
	}
	replaceChildren(...nodes: unknown[]): void {
		this.children = nodes;
	}
	/** Run every listener for `type` to the end. */
	async fire(type: string): Promise<void> {
		await Promise.all(
			(this.listeners.get(type) ?? []).map((listener) =>
				listener({ type, preventDefault() {} }),
			),
		);
	}
}

let elements: Map<string, Stand>;
const element = (id: string): Stand => {
	const found = elements.get(id);
	if (found === undefined) {
		throw new Error(`no stand-in for ${id}`);
	}
	return found;
};

/** The button the cleanup report offers, when it offers one. */
const retryButton = (): Stand | undefined =>
	element("progress").children.find(
		(child): child is Stand => child instanceof Stand,
	);

/** Press the cleanup's button, which must be on offer. */
async function pressRetry(): Promise<void> {
	const button = retryButton();
	if (button === undefined) {
		throw new Error("the cleanup offers no button");
	}
	await button.fire("click");
}

let run: typeof import("../src/scripts/run.ts");

beforeEach(async () => {
	elements = new Map(
		[
			"run-form",
			"contract",
			"spender",
			"connect",
			"run-button",
			"wallet-state",
			"report",
			"progress",
			"rows",
			"summary",
			"copy-md",
			"copy-json",
			"use-demo",
			"faucet",
		].map((id) => [id, new Stand()]),
	);
	vi.stubGlobal("document", {
		getElementById: (id: string) => elements.get(id) ?? null,
		createElement: () => new Stand(),
	});
	vi.resetModules();
	run = await import("../src/scripts/run.ts");
	vi.mocked(run.spendableXlm).mockResolvedValue(10_000_000_000n);
	vi.mocked(run.tokenBalance).mockResolvedValue(100n);
	await import("../src/scripts/checker.ts");
	element("contract").value = DEMO_CONTRACT;
	await element("connect").fire("click");
});

afterEach(() => {
	vi.unstubAllGlobals();
	// `resetModules` rebuilds the mocked modules for the next test; clearing
	// the call history as well keeps each test's own, whatever that does.
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

/** A run whose cleanup waits on `HASH`; its status check answers `next`. */
function owing(next: () => Promise<Cleanup>, settledThrough = 130): RunOutcome {
	return {
		results: [],
		exitCode: 0,
		settledThrough,
		cleanup: {
			failed: `the transfer back could not be confirmed. Transaction ${HASH} may still apply.`,
			pendingTxHash: HASH,
			settledThrough,
			retry: next,
		},
	};
}

const submit = () => element("run-form").fire("submit");
const floorOfRun = (call: number) =>
	vi.mocked(run.runChecks).mock.calls[call]?.[0].minLedger;

describe("the page after a run left a cleanup owed", () => {
	it("holds the next run to the ledger a status check confirmed the send-back in", async () => {
		vi.mocked(run.runChecks)
			.mockResolvedValueOnce(
				owing(async () => ({ returned: 5n, settledThrough: 150 })),
			)
			.mockResolvedValue({ results: [], exitCode: 0 });

		await submit();
		await pressRetry();
		expect(element("run-button").disabled).toBe(false);
		await submit();

		expect(run.runChecks).toHaveBeenCalledTimes(2);
		expect(floorOfRun(1)).toBe(150);
	});

	// The case that separates the two questions, through the page: the
	// transaction can no longer land, so Run opens again; whether it landed
	// is open, so the first press only warns and the key stays; the second
	// discards it, as the warning says, and the run is held to the ledger.
	it("opens Run once the transaction can no longer land, and discards the key only on the second press", async () => {
		const checked: Cleanup = {
			failed: `the transfer back could not be confirmed. Transaction ${HASH} can no longer apply: ledger 200 closed after its deadline. Whether it applied before then is not yet known.`,
			pendingTxHash: HASH,
			closedAfterDeadline: 200,
			settledThrough: 130,
			retry: vi.fn(),
		};
		vi.mocked(run.runChecks)
			.mockResolvedValueOnce(owing(async () => checked))
			.mockResolvedValue({ results: [], exitCode: 0 });

		await submit();
		expect(element("run-button").disabled).toBe(true);
		expect(element("faucet").hidden).toBe(true);
		await pressRetry();
		expect(element("run-button").disabled).toBe(false);
		expect(element("faucet").hidden).toBe(false);

		await submit();
		expect(run.runChecks).toHaveBeenCalledOnce();
		expect(element("wallet-state").textContent).toMatch(
			/outcome is not yet known\. Press “Check transaction status” below — or press Run again to start a new run, which discards the temporary account's key/,
		);
		expect(retryButton()?.textContent).toBe("Check transaction status");

		await submit();
		expect(run.runChecks).toHaveBeenCalledTimes(2);
		expect(floorOfRun(1)).toBe(200);
		expect(checked.retry).not.toHaveBeenCalled();
		expect(retryButton()).toBeUndefined();
	});
});

describe("the page after a faucet claim", () => {
	it("reads the balance, and holds the next run, from the claim's ledger", async () => {
		vi.mocked(run.runChecks)
			.mockResolvedValueOnce({ results: [], exitCode: 0, settledThrough: 130 })
			.mockResolvedValue({ results: [], exitCode: 0 });
		vi.mocked(run.claimDemoTokens).mockResolvedValue({ landed: 145 });

		await submit();
		await element("faucet").fire("click");
		expect(vi.mocked(run.claimDemoTokens).mock.calls[0]?.[0].minLedger).toBe(
			130,
		);
		expect(vi.mocked(run.tokenBalance).mock.calls.at(-1)?.[0].minLedger).toBe(
			145,
		);
		await submit();

		expect(floorOfRun(1)).toBe(145);
	});

	const OPEN = {
		txHash: "cd".repeat(32),
		window: { validUntil: 1_000, earliestLedger: 121 },
	};

	// Sent and not confirmed, the claim may still land under a run's checks:
	// Run waits, and the faucet button looks it up again, whatever the
	// contract field now says. Once it can no longer land, the page goes on
	// from the ledger that rules it out.
	it("holds Run on a claim that may still land, until it can no longer land", async () => {
		vi.mocked(run.claimDemoTokens).mockResolvedValue({ unresolved: OPEN });
		vi.mocked(run.claimStatus)
			.mockResolvedValueOnce({ unresolved: OPEN })
			.mockResolvedValueOnce({
				unresolved: { ...OPEN, closedAfterDeadline: 210 },
			});
		vi.mocked(run.runChecks).mockResolvedValue({ results: [], exitCode: 0 });

		await element("faucet").fire("click");
		expect(element("run-button").disabled).toBe(true);
		expect(element("run-button").textContent).toBe(
			"Check the faucet claim first",
		);
		expect(element("faucet").textContent).toBe("Check the faucet claim");
		await submit();
		expect(run.runChecks).not.toHaveBeenCalled();

		element("contract").value = "not the demo token";
		await element("contract").fire("input");
		expect(element("faucet").hidden).toBe(false);
		element("contract").value = DEMO_CONTRACT;
		await element("contract").fire("input");

		await element("faucet").fire("click");
		expect(element("run-button").disabled).toBe(true);
		await element("faucet").fire("click");
		expect(run.claimStatus).toHaveBeenCalledTimes(2);
		expect(element("run-button").disabled).toBe(false);
		expect(element("faucet").textContent).toBe("Get 5 test VULN");
		expect(vi.mocked(run.tokenBalance).mock.calls.at(-1)?.[0].minLedger).toBe(
			210,
		);

		await submit();
		expect(floorOfRun(0)).toBe(210);
		expect(run.claimDemoTokens).toHaveBeenCalledOnce();
	});

	// A claim that failed on the ledger was applied there, fee and all; one
	// proven expired never was, so it leaves the floor where it was.
	it.each([
		[
			"failed on the ledger",
			{ failed: "the faucet transaction failed on the ledger", ledger: 207 },
			207,
		],
		[
			"expired without landing",
			{ failed: "the faucet transaction expired without landing" },
			undefined,
		],
	])(
		"opens Run again once a status check finds the claim %s",
		async (_case, found, floor) => {
			vi.mocked(run.claimDemoTokens).mockResolvedValue({ unresolved: OPEN });
			vi.mocked(run.claimStatus).mockResolvedValue(found);
			vi.mocked(run.runChecks).mockResolvedValue({ results: [], exitCode: 0 });

			await element("faucet").fire("click");
			await element("faucet").fire("click");
			expect(element("wallet-state").textContent).toBe(
				`The faucet call did not go through: ${found.failed}`,
			);
			expect(element("run-button").disabled).toBe(false);
			await submit();

			expect(floorOfRun(0)).toBe(floor);
		},
	);

	it("holds the next run to the ledger a status check found the claim in", async () => {
		vi.mocked(run.claimDemoTokens).mockResolvedValue({ unresolved: OPEN });
		vi.mocked(run.claimStatus).mockResolvedValue({ landed: 205 });
		vi.mocked(run.runChecks).mockResolvedValue({ results: [], exitCode: 0 });

		await element("faucet").fire("click");
		await element("faucet").fire("click");
		await submit();

		expect(floorOfRun(0)).toBe(205);
	});
});
