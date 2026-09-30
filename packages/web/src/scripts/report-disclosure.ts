/**
 * Disclosure for the report rows rendered at build time. Rows the checker
 * adds later wire their own buttons, because they do not exist yet when
 * this runs.
 *
 * Scoped by class to the recorded report's container rather than by id.
 * An earlier version gave the container `id="rows"`, which the live checker
 * also used: `getElementById` returned this one, so starting a run would
 * have wiped the recorded report and appended list items into a div.
 */
for (const row of document.querySelectorAll<HTMLElement>(
	".recorded-report .row",
)) {
	const button = row.querySelector<HTMLButtonElement>(".why");
	const drawer = row.querySelector<HTMLElement>(".drawer");
	if (button === null || drawer === null) {
		continue;
	}
	button.addEventListener("click", () => {
		const open = !drawer.hidden;
		drawer.hidden = open;
		button.setAttribute("aria-expanded", String(!open));
		button.textContent = open ? "WHY" : "HIDE";
	});
}
