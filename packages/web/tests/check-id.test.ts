import { describe, expect, it } from "vitest";
import { displayId } from "../src/data/check-id.ts";

describe("displayId", () => {
	it("shows a plain member check as the member alone", () => {
		expect(displayId("sep41-decimals")).toEqual({ member: "decimals" });
	});

	// Member names use underscores, so an underscore must not be read as the
	// boundary — `transfer_from` is one member, not `transfer` plus a case.
	it("keeps underscores inside the member", () => {
		expect(displayId("sep41-transfer_from")).toEqual({
			member: "transfer_from",
		});
	});

	it("splits the case off at the first dash", () => {
		expect(displayId("sep41-transfer-self")).toEqual({
			member: "transfer",
			qualifier: "self",
		});
		expect(displayId("sep41-transfer_from-expired")).toEqual({
			member: "transfer_from",
			qualifier: "expired",
		});
	});

	it("turns the remaining dashes of a multi-word case into spaces", () => {
		expect(displayId("sep41-transfer-negative-amount")).toEqual({
			member: "transfer",
			qualifier: "negative amount",
		});
	});

	// Not every id need carry the prefix; one that does not is shown as-is
	// rather than losing its first word.
	it("leaves an unprefixed id intact", () => {
		expect(displayId("approve")).toEqual({ member: "approve" });
	});
});
