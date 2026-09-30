/**
 * Type the home page's terminal card out, line by line, on a loop.
 *
 * Progressive enhancement: the lines are server-rendered and visible, and
 * this only takes over once it runs — so the commands are readable with
 * JavaScript off, and a crawler indexes them.
 *
 * The reveal is per line rather than per character. A character typewriter
 * on a monospace block re-lays out the line on every frame, and at this
 * width the reflow is more distracting than the effect is charming.
 */
const card = document.querySelector<HTMLElement>(".code-out");
const lines =
	card === null ? [] : [...card.querySelectorAll<HTMLElement>(".code-line")];

const still = matchMedia("(prefers-reduced-motion: reduce)");

if (card !== null && lines.length > 0 && !still.matches) {
	let timer = 0;

	const show = (upTo: number) => {
		lines.forEach((line, index) => {
			line.dataset.typed = index < upTo ? "in" : "out";
		});
		// The cursor sits on the line currently being written, and parks on
		// the last one when the run is complete.
		for (const line of lines) {
			delete line.dataset.cursor;
		}
		const cursor = lines[Math.min(upTo, lines.length - 1)];
		if (cursor !== undefined) {
			cursor.dataset.cursor = "on";
		}
	};

	const run = () => {
		// A re-entry while a chain is still pending would start a second one
		// sharing `timer`, and the two would fight over the lines. Only one
		// chain ever runs.
		window.clearTimeout(timer);
		let step = 0;
		show(0);
		const tick = () => {
			step += 1;
			show(step);
			if (step < lines.length) {
				// Blank lines pass quickly; a command line holds long enough to
				// be read before the next arrives.
				const blank = lines[step - 1]?.textContent?.trim() === "";
				timer = window.setTimeout(tick, blank ? 120 : 420);
			} else {
				// Hold the finished block, then start over.
				timer = window.setTimeout(run, 4200);
			}
		};
		timer = window.setTimeout(tick, 500);
	};

	// Only animate while the card is on screen: a loop running in a
	// background section costs frames and shows nobody anything.
	const watcher = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (entry.isIntersecting) {
				run();
			} else {
				window.clearTimeout(timer);
			}
		}
	});
	watcher.observe(card);

	// Respecting a change of preference mid-session, rather than only at
	// load.
	still.addEventListener("change", (event) => {
		if (event.matches) {
			watcher.disconnect();
			window.clearTimeout(timer);
			for (const line of lines) {
				delete line.dataset.typed;
				delete line.dataset.cursor;
			}
		}
	});
}
