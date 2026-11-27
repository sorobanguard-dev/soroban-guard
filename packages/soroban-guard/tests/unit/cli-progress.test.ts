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
		progress.check({
			kind: "started",
			id: "sep41-transfer_from-expired",
			completed: 1,
			total: 2,
		});
		expect(write).toHaveBeenLastCalledWith(
			"\r\u001B[2K1/2 complete | checking transfer_from-expired | 0s elapsed",
		);
		progress.stage("waiting for allowance expiry");
		vi.advanceTimersByTime(3_000);
		expect(write).toHaveBeenLastCalledWith(
			"\r\u001B[2K1/2 complete | waiting for allowance expiry | 3s elapsed",
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
