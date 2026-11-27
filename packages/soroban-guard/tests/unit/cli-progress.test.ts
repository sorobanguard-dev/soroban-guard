import { expect, it, vi } from "vitest";
import { createCliProgress } from "../../src/cli-progress.ts";

it("refreshes elapsed time during a wait and clears the line when stopped", () => {
	vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval"] });
	const write = vi.fn((_text: string) => true);
	const progress = createCliProgress(
		[{ id: "sep41-decimals" }, { id: "sep41-transfer_from-expired" }],
		{ write, columns: 80 },
		{
			interactive: true,
			color: false,
		},
	);
	try {
		progress.stage("inspecting contract");
		vi.advanceTimersByTime(65_000);
		expect(write).toHaveBeenLastCalledWith(
			"\r\u001B[2K0/2 complete | 65s setup | inspecting contract",
		);
		progress.check({
			kind: "started",
			id: "sep41-transfer_from-expired",
			completed: 1,
			total: 2,
		});
		expect(write).toHaveBeenLastCalledWith(
			"\r\u001B[2K1/2 complete | 0s this check | checking transfer_from-expired",
		);
		progress.stage("waiting for allowance expiry");
		vi.advanceTimersByTime(3_000);
		expect(write).toHaveBeenLastCalledWith(
			"\r\u001B[2K1/2 complete | 3s this check | waiting for allowance expiry",
		);
		progress.stage("preparing transfer_from transaction");
		expect(write).toHaveBeenLastCalledWith(
			"\r\u001B[2K1/2 complete | 3s this check | preparing transfer_from transaction",
		);
		progress.stop();
		expect(write).toHaveBeenLastCalledWith("\r\u001B[2K");
		const writes = write.mock.calls.length;
		vi.advanceTimersByTime(3_000);
		expect(write).toHaveBeenCalledTimes(writes);
	} finally {
		progress.stop();
		vi.useRealTimers();
	}
});
