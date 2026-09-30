// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

/**
 * Static output, deliberately. There is no server in this product: the
 * checks talk to Soroban RPC from the browser and sign through the
 * visitor's own wallet extension, so a backend could only sit in the way —
 * holding keys it should not hold, or proxying calls it cannot improve.
 *
 * What that buys is the point of choosing Astro at all. The marketing page
 * is pre-rendered HTML that a crawler reads without running anything, and
 * the 674 kB Stellar SDK loads only when someone actually engages the
 * checker island. A framework that hydrated the whole page would put that
 * bundle in front of the first paint.
 */
export default defineConfig({
	site: "https://sorobanguard.com",
	output: "static",
	/*
	 * Pages as `run.html`, not `run/index.html`, and addresses without a
	 * trailing slash. Cloudflare Pages serves `run.html` at `/run`, which is
	 * how every link on the site spells it; built as a directory, each of
	 * those links answered with a 308 to `/run/` first, and the canonical
	 * URL disagreed with the links pointing at it.
	 */
	build: { format: "file" },
	trailingSlash: "never",
	vite: {
		/*
		 * Pre-bundled when the dev server starts, not on first use. The
		 * checker is a lazy import, so without this Vite met the Stellar SDK
		 * and the Freighter library only when a visitor touched the form,
		 * re-optimised its dependencies mid-page, and the in-flight import
		 * failed — "The checker could not load" on every first try in dev.
		 * Freighter's library also ships CommonJS, which the browser cannot
		 * import until Vite converts it. The production build is unaffected:
		 * there every chunk exists before the page is served.
		 */
		optimizeDeps: {
			include: ["@stellar/stellar-sdk", "@stellar/freighter-api"],
		},
		resolve: {
			alias: [
				{
					// Deep imports go to the sibling package's TypeScript
					// sources, not its compiled `dist`: the site then builds
					// without running the CLI's build first. Its package
					// `exports` expose only the root, so deep paths are aliased
					// here rather than widening the published surface.
					find: /^soroban-guard\/(.*)$/,
					replacement: `${fileURLToPath(new URL("../soroban-guard", import.meta.url))}/$1`,
				},
			],
		},
	},
});
