/**
 * Copy buttons for commands on the page: `<button data-copy="id">` copies
 * the text of the element with that id.
 *
 * Falls back to selecting the text, so a browser that refuses clipboard
 * access still leaves it one keystroke away.
 */
for (const button of document.querySelectorAll<HTMLButtonElement>(
	"button[data-copy]",
)) {
	button.addEventListener("click", async () => {
		const target = document.getElementById(button.dataset.copy ?? "");
		if (target === null) {
			return;
		}
		try {
			await navigator.clipboard.writeText(target.textContent ?? "");
			button.textContent = "Copied";
		} catch {
			const range = document.createRange();
			range.selectNodeContents(target);
			const selection = getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			button.textContent = "Selected";
		}
		window.setTimeout(() => {
			button.textContent = "Copy";
		}, 1600);
	});
}
