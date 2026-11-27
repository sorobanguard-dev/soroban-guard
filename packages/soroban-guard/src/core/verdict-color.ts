import type { StyleName } from "./ansi.ts";
import type { CheckStatus } from "./types.ts";

export const VERDICT_COLOR: Readonly<Record<CheckStatus, StyleName>> = {
	PASS: "green",
	FAIL: "red",
	UNVERIFIABLE: "yellow",
	SKIPPED: "grey",
	NOT_IMPLEMENTED: "grey",
};
