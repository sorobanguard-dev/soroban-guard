import type { Cleanup } from "./run.ts";

/**
 * Whether a transaction the owed cleanup waits on may still land, and move
 * the wallet's balance under a faucet claim's read or a run's checks: until
 * `closedAfterDeadline` (see `Cleanup`) says it cannot. Kept apart from the
 * page script, which touches the DOM on import, so it can be tested.
 */
export function mayStillLand(owed: Cleanup | undefined): boolean {
	return (
		owed !== undefined &&
		"failed" in owed &&
		owed.pendingTxHash !== undefined &&
		owed.closedAfterDeadline === undefined
	);
}

/**
 * Whether Run may start while the last run still owes a send-back.
 *
 * The temporary account's key lives only in a retry closure, and a new run
 * replaces the page state that holds it. So the first Run with a send-back
 * owed explains and stops; a second Run for the same one may proceed. The
 * key is dropped only when a run actually starts the suite — a run stopped
 * earlier by another gate keeps it, so the retry can be offered again.
 */
export function owedSendBack<T>() {
	let pending: T | undefined;
	let warned: T | undefined;
	return {
		/**
		 * Record what the last cleanup left owed, or `undefined` for nothing.
		 * Nothing the page no longer owes is held, since its retry reaches the
		 * temporary key: the warning is kept only for the same send-back.
		 */
		owe(owed: T | undefined): void {
			if (owed !== warned) {
				warned = undefined;
			}
			pending = owed;
		},
		/** What is still owed, if anything. */
		pending(): T | undefined {
			return pending;
		},
		/**
		 * `"warn"` the first time Run meets this owed send-back; `"run"`
		 * otherwise. Drops nothing: see `abandon`.
		 */
		onRun(): "warn" | "run" {
			if (pending === undefined || warned === pending) {
				return "run";
			}
			warned = pending;
			return "warn";
		},
		/** The run is starting the suite: the visitor chose to leave the units. */
		abandon(): void {
			pending = undefined;
			warned = undefined;
		},
	};
}
