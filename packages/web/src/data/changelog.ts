import source from "../../../../CHANGELOG.md?raw";
import { type Block, blocks } from "./markdown.ts";

/**
 * The releases in the repository's CHANGELOG.md, read at build time.
 *
 * The file is the single source: the page is rebuilt from it on every
 * deploy, so it cannot say something the repository does not. Two parts of
 * the file are left out on purpose — the preamble, which is instructions
 * for whoever writes the next entry, and an `[Unreleased]` section with
 * nothing in it, which to a reader looks like a release that shipped empty.
 */
export interface Release {
	readonly version: string;
	/** ISO date as written in the heading; absent for `Unreleased`. */
	readonly date?: string;
	/** The prose between the heading and the first `###`. */
	readonly summary: readonly Block[];
	readonly sections: readonly {
		readonly title: string;
		readonly blocks: readonly Block[];
	}[];
}

const RELEASE_HEADING = /^## \[([^\]]+)\](?:\s+—\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

export function parseChangelog(markdown: string): Release[] {
	const releases: Release[] = [];
	const chunks = markdown.replace(/\r\n/g, "\n").split(/^(?=## \[)/m);

	// The first chunk is the title and preamble.
	for (const chunk of chunks.slice(1)) {
		const [heading, ...rest] = chunk.split("\n");
		const match = RELEASE_HEADING.exec(heading);
		if (match === null) {
			throw new Error(`CHANGELOG.md: unreadable release heading: ${heading}`);
		}
		const [summaryText, ...sectionTexts] = rest.join("\n").split(/^### /m);
		const sections = sectionTexts.map((text) => {
			const [title, ...body] = text.split("\n");
			return { title: title.trim(), blocks: blocks(body.join("\n")) };
		});
		const summary = blocks(summaryText);
		if (summary.length === 0 && sections.length === 0) {
			continue;
		}
		releases.push({ version: match[1], date: match[2], summary, sections });
	}
	return releases;
}

/**
 * The newest release that has actually shipped: the first one with a date.
 *
 * Not simply the first entry. `[Unreleased]` is skipped only while empty,
 * so the moment it gains an entry it would lead the list — and a plain
 * `RELEASES[0]` would badge it "Latest" and link npm to a version called
 * `Unreleased`.
 */
export function latestRelease(
	releases: readonly Release[],
): Release | undefined {
	return releases.find((release) => release.date !== undefined);
}

export const RELEASES: readonly Release[] = parseChangelog(source);
export const LATEST: Release | undefined = latestRelease(RELEASES);
