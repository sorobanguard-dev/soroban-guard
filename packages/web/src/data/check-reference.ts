import source from "../../../../docs/check-reference.md?raw";
import { checkAnchor, displayId } from "./check-id.ts";
import { type Block, blocks } from "./markdown.ts";

/**
 * docs/check-reference.md as structured data, read at build time.
 *
 * The document is written for the repository, one `###` per check in run
 * order, grouped under `## Reads` and `## Writes`. Parsed rather than
 * rendered whole so each check becomes an addressable entry — the report's
 * rows can link to `/checks#transfer-self` — and so the page keeps the
 * site's layout instead of a README's.
 */
export interface CheckEntry {
	/** The stable id, `sep41-` prefix included, as the CLI reports it. */
	readonly id: string;
	/** Anchor on the page: the id without the prefix. */
	readonly anchor: string;
	readonly member: string;
	readonly qualifier?: string;
	/** `interface` checks only read; `behavior` checks observe effects. */
	readonly layer: "interface" | "behavior";
	readonly body: readonly Block[];
}

export interface CheckGroup {
	readonly title: string;
	readonly intro: readonly Block[];
	readonly checks: readonly CheckEntry[];
}

export interface CheckReference {
	/** The method notes before the first group: premises, ordering. */
	readonly method: readonly Block[];
	readonly groups: readonly CheckGroup[];
}

const CHECK_HEADING = /^`(sep41-[a-z_-]+)`\s+—\s+(interface|behavior)\s*$/;

export function parseCheckReference(markdown: string): CheckReference {
	const [head, ...groupTexts] = markdown.replace(/\r\n/g, "\n").split(/^## /m);
	// Drop the `# Checks reference` title line; the page has its own.
	const method = blocks(head.replace(/^# .*\n/, ""));

	const groups: CheckGroup[] = [];
	for (const text of groupTexts) {
		const [title, ...rest] = text.split("\n");
		const [introText, ...checkTexts] = rest.join("\n").split(/^### /m);
		// `## Verdicts` is left out by name: the site explains verdicts on the
		// home page. Any other section without checks is an error rather
		// than a silent drop — a new `## Premises` in the doc would otherwise
		// vanish from the page with every test still green.
		if (checkTexts.length === 0) {
			if (title.trim() === "Verdicts") {
				continue;
			}
			throw new Error(
				`check-reference.md: section "${title.trim()}" has no checks; render it on /checks or skip it by name`,
			);
		}
		const checks = checkTexts.map((checkText) => {
			const [heading, ...body] = checkText.split("\n");
			const match = CHECK_HEADING.exec(heading.trim());
			if (match === null) {
				throw new Error(
					`check-reference.md: unreadable check heading: ${heading}`,
				);
			}
			const id = match[1];
			const { member, qualifier } = displayId(id);
			return {
				id,
				anchor: checkAnchor(id),
				member,
				qualifier,
				layer: match[2] as CheckEntry["layer"],
				body: blocks(body.join("\n")),
			};
		});
		groups.push({ title: title.trim(), intro: blocks(introText), checks });
	}
	return { method, groups };
}

export const CHECK_REFERENCE: CheckReference = parseCheckReference(source);
