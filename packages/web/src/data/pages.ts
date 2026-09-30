/**
 * The site's pages, for places that list them all — today the 404 page.
 *
 * One list, so adding a page means adding it here, rather than finding
 * every hand-written set of links that should now include it.
 */
export const PAGES: readonly {
	readonly href: string;
	readonly label: string;
}[] = [
	{ href: "/", label: "Home" },
	{ href: "/run", label: "Run in your browser" },
	{ href: "/checks", label: "Checks" },
	{ href: "/changelog", label: "Changelog" },
];
