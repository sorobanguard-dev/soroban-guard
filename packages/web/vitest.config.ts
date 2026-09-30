import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest needs the same alias `astro.config.mjs` gives the build: the guard
 * package exposes only its root through `exports`, so deep imports of its
 * sources resolve through this map rather than through node resolution.
 * Kept as its own file because Astro's config is not a Vitest config, and a
 * shared one would couple the test runner to the site's build options.
 */
export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^soroban-guard\/(.*)$/,
				replacement: `${fileURLToPath(new URL("../soroban-guard", import.meta.url))}/$1`,
			},
		],
	},
});
