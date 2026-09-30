/**
 * The checker — and with it the 674 kB Stellar SDK — is fetched on first
 * interaction, not on page load.
 *
 * A static `import` would be bundled eagerly and served in a module script
 * tag. Someone who reads the page and never runs a check should not pay
 * for the SDK, so the module is pulled in when the section first scrolls
 * into view or someone reaches for a control inside it — whichever happens
 * first.
 *
 * Kept in a `.ts` module rather than inline in `Checker.astro`, so Biome
 * and `tsc` check it: neither reads a script inside an `.astro` file.
 *
 * Idempotent: `import()` caches the module, and the listeners remove
 * themselves after the first hit.
 */
const section = document.getElementById("run");

let loading: Promise<unknown> | null = null;
let ready = false;

/*
 * A failed download says so. Before, the rejected promise stayed cached
 * and every later click failed silently with the form sitting dead. The
 * status line now tells the visitor to reload — the browser also caches a
 * failed module import by URL, so only a reload can recover — and the
 * error itself goes to the console.
 */
function loadChecker(): Promise<unknown> {
	loading ??= import("./checker.ts").then(
		(module) => {
			ready = true;
			return module;
		},
		(error: unknown) => {
			loading = null;
			// The reason goes to the console: the status line is for the
			// visitor, and it was the only trace the last failure left.
			console.error("soroban-guard: the checker failed to load", error);
			const state = document.getElementById("wallet-state");
			if (state !== null) {
				// Reload, not retry: a browser caches a failed module import for
				// its URL, so pressing a button again cannot succeed.
				state.textContent =
					"The checker could not load. Check your connection and reload the page.";
				state.dataset.tone = "error";
			}
			throw error;
		},
	);
	return loading;
}

/** Start loading; a failure is already reported on the page. */
function preload(): void {
	loadChecker().catch(() => undefined);
}

if (section !== null) {
	/*
	 * A click that lands before the module has loaded is held, then
	 * replayed. Without this, the first press of "Connect Freighter" on a
	 * cold cache went nowhere: `pointerdown` started the download, the
	 * click fired a moment later, and no handler existed yet to receive it
	 * — the button looked broken. Capture phase, so it runs before the
	 * browser acts on a submit button and reloads the page.
	 */
	section.addEventListener(
		"click",
		(event) => {
			if (ready) {
				return;
			}
			const button = (event.target as Element | null)?.closest("button");
			if (button === null || button === undefined) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			// On failure the status line already explains; nothing to replay.
			loadChecker().then(
				() => button.click(),
				() => undefined,
			);
		},
		{ capture: true },
	);

	// Reaching for any control is an unambiguous intent to use it.
	for (const event of ["pointerdown", "focusin", "keydown"] as const) {
		section.addEventListener(event, preload, { once: true });
	}

	// Scrolling it into view means the controls are about to be usable, so
	// the module is already in flight by the time one is touched.
	if ("IntersectionObserver" in window) {
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				observer.disconnect();
				preload();
			}
		});
		observer.observe(section);
	} else {
		preload();
	}
}
