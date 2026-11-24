import { describe, expect, it } from "vitest";
import { mayStillLand, owedSendBack } from "../src/scripts/owed.ts";

// Only a cleanup that waits on a transaction holds Run and the faucet, and
// only until a ledger closes past that transaction's deadline: up to then
// it can still land and move the wallet's balance.
describe("mayStillLand", () => {
	it.each([
		["nothing is owed", undefined, false],
		["a send-back failed and can be retried", { failed: "x" }, false],
		[
			"a send-back may still apply",
			{ failed: "x", pendingTxHash: "ab".repeat(32) },
			true,
		],
		[
			"a ledger closed after its deadline, whether or not it applied",
			{ failed: "x", pendingTxHash: "ab".repeat(32), closedAfterDeadline: 200 },
			false,
		],
	])("is right when %s", (_case, owed, expected) => {
		expect(mayStillLand(owed)).toBe(expected);
	});
});

/**
 * Run with units still owed back: the temporary account's key lives only
 * in the retry, so a run must not drop it without the visitor choosing to.
 */
describe("owedSendBack", () => {
	it("runs straight away when nothing is owed", () => {
		const owed = owedSendBack<symbol>();
		expect(owed.onRun()).toBe("run");
	});

	it("warns once, then lets the next Run through", () => {
		const owed = owedSendBack<symbol>();
		owed.owe(Symbol("retry"));
		expect(owed.onRun()).toBe("warn");
		expect(owed.onRun()).toBe("run");
	});

	// A second Run can still be stopped by a later gate (the reads-only
	// confirmation, the fee check). Letting it through must not drop the
	// key — only the suite starting does.
	it("keeps what is owed until the run abandons it", () => {
		const owed = owedSendBack<symbol>();
		const retry = Symbol("retry");
		owed.owe(retry);
		owed.onRun();
		owed.onRun();
		expect(owed.pending()).toBe(retry);
		owed.abandon();
		expect(owed.pending()).toBeUndefined();
		expect(owed.onRun()).toBe("run");
	});

	// Re-offered after a stopped run, the same send-back is not warned
	// about twice.
	it("does not warn again when the same send-back is owed again", () => {
		const owed = owedSendBack<symbol>();
		const retry = Symbol("retry");
		owed.owe(retry);
		expect(owed.onRun()).toBe("warn");
		owed.owe(retry);
		expect(owed.onRun()).toBe("run");
	});

	// A retry that fails again hands back a new one — new units at stake,
	// so the earlier confirmation does not carry over.
	it("warns again for a new owed send-back", () => {
		const owed = owedSendBack<symbol>();
		owed.owe(Symbol("first"));
		expect(owed.onRun()).toBe("warn");
		owed.owe(Symbol("second"));
		expect(owed.onRun()).toBe("warn");
	});

	it("runs without a warning once the send-back succeeds", () => {
		const owed = owedSendBack<symbol>();
		owed.owe(Symbol("retry"));
		owed.owe(undefined);
		expect(owed.onRun()).toBe("run");
	});

	// The retry reaches the temporary key, so a send-back the page no longer
	// owes is not held, not even as the one last warned about: offered again
	// afterwards, it is warned about afresh.
	it.each([
		[
			"the run abandons it",
			(owed: ReturnType<typeof owedSendBack<symbol>>) => owed.abandon(),
		],
		[
			"another one replaces it",
			(owed: ReturnType<typeof owedSendBack<symbol>>) =>
				owed.owe(Symbol("other")),
		],
		[
			"nothing is owed any more",
			(owed: ReturnType<typeof owedSendBack<symbol>>) => owed.owe(undefined),
		],
	])("lets go of a send-back once %s", (_case, release) => {
		const owed = owedSendBack<symbol>();
		const retry = Symbol("retry");
		owed.owe(retry);
		expect(owed.onRun()).toBe("warn");
		release(owed);
		owed.owe(retry);
		expect(owed.onRun()).toBe("warn");
	});
});
