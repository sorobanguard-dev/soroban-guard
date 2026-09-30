/**
 * Make the README's repository-relative links absolute for npmjs.com.
 *
 * The README's relative links (`docs/check-reference.md`,
 * `CONTRIBUTING.md`, …) resolve against the package on npmjs.com, not the
 * repository, so the published copy points them at GitHub instead. The
 * root file keeps its relative links for readers on GitHub.
 *
 * A link target is rewritten when it is neither absolute, an in-page
 * anchor, nor a mailto: — i.e. a path into the repository.
 */
const RELATIVE_LINK = /\]\((?!https?:|#|mailto:)(?:\.\/)?([^)\s]+)\)/g;

export function absoluteLinks(
	readme: string,
	repo: string,
): { text: string; changed: number } {
	let changed = 0;
	const text = readme.replace(RELATIVE_LINK, (_match, path: string) => {
		changed += 1;
		return `](${repo}${path})`;
	});
	return { text, changed };
}
