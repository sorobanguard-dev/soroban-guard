/**
 * Play the "How a run works" rail when it is actually on screen.
 *
 * The rail and dots are drawn by default. Only here, with a way to tell
 * when the list is visible, are they rewound (`data-seen="no"`) and then
 * released (`"yes"`) — so without this script, or without
 * IntersectionObserver, the reader simply sees the finished state rather
 * than a line that never appears.
 */
const steps = document.querySelector<HTMLElement>(".steps");

if (steps !== null && "IntersectionObserver" in window) {
	steps.dataset.seen = "no";
	const watcher = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					steps.dataset.seen = "yes";
					watcher.disconnect();
				}
			}
		},
		// A little into view, so the draw is not half over by the time the
		// section is readable.
		{ rootMargin: "0px 0px -15% 0px" },
	);
	watcher.observe(steps);
}
