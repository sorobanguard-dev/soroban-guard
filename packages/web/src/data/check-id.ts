/**
 * How a check id is shown on screen.
 *
 * Every id carries the standard as a prefix — `sep41-transfer-self` — which
 * is right for the data (ids stay unique if a second suite is ever added)
 * and wrong for a report, where it repeats the same word on every row and
 * pushes the part that differs out of view. The report says the standard
 * once, in its header; each row shows only what distinguishes it.
 *
 * The id is split into the SEP-41 member being exercised and, where there
 * is one, the case: `transfer_from-expired` reads as the member
 * `transfer_from` in the case `expired`. Display only — the full id is
 * what the copied CHECKS.md and JSON carry, and what a row's tooltip shows.
 */

export interface DisplayId {
	/** The interface member, e.g. `transfer_from`. */
	readonly member: string;
	/** The case being exercised, in words, e.g. `zero amount`; absent for a plain member check. */
	readonly qualifier?: string;
}

/**
 * The standard prefix, stripped for display. A single known prefix rather
 * than "anything before the first dash": member names contain underscores,
 * never dashes, so the first dash after the prefix is always the boundary
 * between member and case.
 */
const STANDARD_PREFIX = "sep41-";

export function displayId(id: string): DisplayId {
	const bare = id.startsWith(STANDARD_PREFIX)
		? id.slice(STANDARD_PREFIX.length)
		: id;
	const boundary = bare.indexOf("-");
	if (boundary < 0) {
		return { member: bare };
	}
	return {
		member: bare.slice(0, boundary),
		qualifier: bare.slice(boundary + 1).replaceAll("-", " "),
	};
}

/**
 * The check's anchor on /checks: the id without the standard's prefix,
 * as it is shown everywhere on the site. Kept here rather than beside the
 * parser, so the browser checker can link to an entry without bundling
 * the whole reference document.
 */
export function checkAnchor(id: string): string {
	return id.startsWith(STANDARD_PREFIX) ? id.slice(STANDARD_PREFIX.length) : id;
}
