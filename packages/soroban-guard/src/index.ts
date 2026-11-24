/**
 * Package entry point. Re-exports the standard-agnostic engine (`core/`)
 * alongside the SEP-41 suite (`sep41/`), so a consumer can run the bundled
 * suite or assemble its own from the same primitives.
 *
 * The one-way dependency is the whole design: `core/` never imports
 * `sep41/`, so a second standard plugs in without touching the runner.
 * Verify it with `git grep sep41 -- src/core` — it returns nothing.
 */
export * from "./core/ansi.ts";
export * from "./core/funding.ts";
// Named, not `*`: settling a sent transaction (`sendAndFollow`,
// `lookupOutcome`, `mayHaveExpired`) is internal, and a wildcard would
// publish every helper added to this module. The types come along only
// where a public signature needs them.
export {
	addressArg,
	amountArg,
	type HistoryProgress,
	I128_MAX,
	type InclusionWindow,
	type InvokeResult,
	interpretSimulation,
	ledgerArg,
	type ReadCall,
	type SubmitResult,
	simulateRead,
	submitWrite,
	type WriteCall,
	type WriteTiming,
} from "./core/invoke.ts";
export * from "./core/json-report.ts";
export * from "./core/md-report.ts";
export * from "./core/pretty.ts";
export * from "./core/report.ts";
export * from "./core/runner.ts";
export * from "./core/spec.ts";
export * from "./core/types.ts";
export * from "./sep41/index.ts";
