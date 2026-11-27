import { style } from "./core/ansi.ts";
import type { CheckProgress } from "./core/runner.ts";
import { VERDICT_COLOR } from "./core/verdict-color.ts";

const CLEAR_LINE = "\r\u001B[2K";

function shortCheckId(id: string): string {
	return id.replace(/^sep41-/, "");
}

export function createCliProgress(
	checks: readonly { id: string }[],
	stream: Pick<NodeJS.WriteStream, "columns" | "write">,
	{ interactive, color }: { interactive: boolean; color: boolean },
) {
	const total = checks.length;
	const countWidth = String(total).length;
	const nameWidth = checks.reduce(
		(width, { id }) => Math.max(width, shortCheckId(id).length),
		0,
	);
	const setupStartedAt = performance.now();
	let completed = 0;
	let check: { name: string; startedAt: number } | undefined;
	let stage: string | undefined;
	let visible = false;

	function refresh(): void {
		const activity = stage ?? (check && `checking ${check.name}`);
		if (activity === undefined) return;
		const startedAt = check?.startedAt ?? setupStartedAt;
		const elapsed = Math.floor((performance.now() - startedAt) / 1000);
		const timing = check === undefined ? "setup" : "this check";
		const text = `${completed}/${total} complete | ${elapsed}s ${timing} | ${activity}`;
		if (interactive) {
			// Leave a column free so the terminal does not wrap the live line.
			const width = Math.max(1, (stream.columns || 80) - 1);
			stream.write(`${CLEAR_LINE}${text.slice(0, width)}`);
			visible = true;
		} else {
			stream.write(`${text}\n`);
		}
	}

	const timer = interactive ? setInterval(refresh, 1_000).unref() : undefined;

	return {
		stage(message: string | undefined): void {
			stage = message;
			if (interactive || message !== undefined) refresh();
		},
		check(event: CheckProgress): void {
			completed = event.completed;
			stage = undefined;
			if (event.kind === "started") {
				check = { name: shortCheckId(event.id), startedAt: performance.now() };
				if (interactive) refresh();
				return;
			}
			check = undefined;
			const { status, id, durationMs } = event.result;
			const count = String(completed).padStart(countWidth);
			const name = shortCheckId(id).padEnd(nameWidth);
			const duration = `(${(durationMs / 1000).toFixed(1)}s)`.padStart(8);
			const verdict = style(status, VERDICT_COLOR[status], color);
			stream.write(
				`${visible ? CLEAR_LINE : ""}[${count}/${total}] ${name}  ${duration}  ${verdict}\n`,
			);
			visible = false;
		},
		stop(): void {
			clearInterval(timer);
			if (visible) {
				stream.write(CLEAR_LINE);
				visible = false;
			}
		},
	};
}
