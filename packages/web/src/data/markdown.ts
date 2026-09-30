/**
 * The small subset of Markdown that CHANGELOG.md and check-reference.md
 * actually use, rendered to HTML at build time.
 *
 * Not a general Markdown renderer, deliberately. Astro 7's own pipeline is
 * not a public API to call on an arbitrary string, and pulling in a full
 * parser for two files we write ourselves would be more surface than the
 * job needs. What those files contain — paragraphs, `-` lists whose items
 * may run to several paragraphs, `code`, **bold**, *emphasis* and links —
 * is handled here and pinned by tests against the real files, so a new
 * construct in either file fails the build's tests instead of rendering as
 * stray asterisks.
 */

export type Block =
	| { readonly kind: "p"; readonly html: string }
	| { readonly kind: "ul"; readonly items: readonly (readonly string[])[] };

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/**
 * Check ids appear in the docs as `sep41-transfer-self`; the site shows
 * them without the standard's prefix, as the report does, because every
 * page already says which standard it is about.
 *
 * Only check ids — a prefix followed by a SEP-41 member. The changelog
 * also names the old `sep41-guard` command, and stripping every prefix
 * rewrote history into a `guard` command that never existed.
 */
const CHECK_ID_PREFIX =
	/^sep41-(?=(?:decimals|balance|allowance|name|symbol|transfer|approve|burn))/;

function codeSpan(code: string): string {
	return `<code>${escapeHtml(code.replace(CHECK_ID_PREFIX, ""))}</code>`;
}

/** Emphasis and links, on text that is already escaped. */
function decorate(escaped: string): string {
	return escaped
		.replace(
			/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
			(_match, label: string, url: string) =>
				`<a href="${url}" rel="noopener">${label}</a>`,
		)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, "$1<em>$2</em>");
}

/**
 * One line or paragraph of inline Markdown to HTML.
 *
 * Code spans are cut out first so nothing inside them is read as emphasis:
 * `i128::MAX` or `*_ADDRESS` must survive exactly as written.
 */
export function inline(markdown: string): string {
	return markdown
		.split(/(`[^`]+`)/g)
		.map((part) =>
			part.startsWith("`") && part.endsWith("`") && part.length > 1
				? codeSpan(part.slice(1, -1))
				: decorate(escapeHtml(part)),
		)
		.join("");
}

/** Join wrapped source lines into one paragraph's text. */
function unwrap(lines: readonly string[]): string {
	return lines.map((line) => line.trim()).join(" ");
}

/**
 * Paragraphs and bullet lists.
 *
 * A list item runs until the next `- ` at column zero or an unindented
 * paragraph. Lines indented under it — including whole further paragraphs
 * after a blank line, as the 0.4.0 entry has — belong to that item.
 */
export function blocks(markdown: string): Block[] {
	const out: Block[] = [];
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let paragraph: string[] = [];
	let items: string[][] | null = null;
	let itemParagraphs: string[][] = [];
	let itemLines: string[] = [];

	const flushParagraph = () => {
		if (paragraph.length > 0) {
			out.push({ kind: "p", html: inline(unwrap(paragraph)) });
			paragraph = [];
		}
	};
	const flushItemParagraph = () => {
		if (itemLines.length > 0) {
			itemParagraphs.push(itemLines);
			itemLines = [];
		}
	};
	const flushItem = () => {
		flushItemParagraph();
		if (items !== null && itemParagraphs.length > 0) {
			items.push(itemParagraphs.map((p) => inline(unwrap(p))));
		}
		itemParagraphs = [];
	};
	const flushList = () => {
		flushItem();
		if (items !== null && items.length > 0) {
			out.push({ kind: "ul", items });
		}
		items = null;
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.startsWith("- ")) {
			flushParagraph();
			flushItem();
			items ??= [];
			itemLines = [line.slice(2)];
		} else if (items !== null && /^\s{2,}\S/.test(line)) {
			itemLines.push(line);
		} else if (line.trim() === "") {
			if (items !== null) {
				// A blank line inside a list ends the item's paragraph; the
				// item itself continues only if the next line is indented.
				flushItemParagraph();
				const next = lines[index + 1] ?? "";
				if (!/^\s{2,}\S/.test(next) && !next.startsWith("- ")) {
					flushList();
				}
			} else {
				flushParagraph();
			}
		} else {
			if (items !== null) {
				flushList();
			}
			paragraph.push(line);
		}
	}
	flushParagraph();
	flushList();
	return out;
}
