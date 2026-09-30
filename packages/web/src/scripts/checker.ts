/**
 * The page: collect an address, connect a wallet, run the suite, render it.
 *
 * Every verdict on screen comes from the shared check implementation — this
 * file decides nothing about conformance. What it owns is the part a
 * terminal gets for free: telling the visitor what will happen before it
 * happens, and what went wrong in terms they can act on.
 */

import { renderJsonReport } from "soroban-guard/src/core/json-report.ts";
import { renderMarkdownReport } from "soroban-guard/src/core/md-report.ts";
import {
	type CheckResult,
	STATUS_GLYPH,
} from "soroban-guard/src/core/types.ts";
import { checkAnchor, displayId } from "../data/check-id.ts";
import {
	DEMO_CONTRACT,
	DEMO_FAUCET_UNITS,
	isDemoContract,
} from "../data/demo.ts";
import { explainFailure, forBrowser } from "../data/wording.ts";
import {
	connect,
	isFreighterInstalled,
	WalletError,
	walletNetwork,
} from "./freighter.ts";
import {
	claimDemoTokens,
	looksLikeAccountId,
	looksLikeContractId,
	runChecks,
	STROOPS_PER_XLM,
	spendableXlm,
	tokenBalance,
} from "./run.ts";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";

// The glyphs come from core, not a copy here: a second table drifts, and
// this one already had — it printed an em dash for SKIPPED where the CLI
// prints ○. One export, one set of symbols, both surfaces agree.

function el<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (found === null) {
		throw new Error(`missing element: ${id}`);
	}
	return found as T;
}

const form = el<HTMLFormElement>("run-form");
const contractInput = el<HTMLInputElement>("contract");
const spenderInput = el<HTMLInputElement>("spender");
const connectButton = el<HTMLButtonElement>("connect");
// `run-button`, not `run`: the section owns `#run` as a scroll anchor, and
// `el()` would have found the section, cast it to a button, and left the
// control permanently disabled without ever throwing.
const runButton = el<HTMLButtonElement>("run-button");
const walletState = el<HTMLParagraphElement>("wallet-state");
const report = el<HTMLElement>("report");
const progress = el<HTMLParagraphElement>("progress");
const rows = el<HTMLOListElement>("rows");
const summary = el<HTMLParagraphElement>("summary");
const copyMarkdown = el<HTMLButtonElement>("copy-md");
const copyJson = el<HTMLButtonElement>("copy-json");
const useDemoButton = el<HTMLButtonElement>("use-demo");
const faucetButton = el<HTMLButtonElement>("faucet");

let connected: string | null = null;
let lastResults: readonly CheckResult[] = [];
/**
 * When the last run happened, ISO-8601.
 *
 * The renderers take this rather than reading the clock, so their output is
 * reproducible in a test — which means the page has to remember it, not
 * stamp a fresh `now` each time someone copies the report.
 */
let lastRanAt = "";

/** Guards against a second run starting while one is in flight. */
let running = false;

/**
 * The `contract:wallet` pair whose empty balance the visitor has already
 * been told about. The first Run with no balance explains and stops; a
 * second for the same pair means "run the reads anyway".
 */
let readsOnlyConfirmed = "";

/**
 * The contract the last run assessed.
 *
 * Held separately from the input, because the report renderers are called
 * when someone copies the output — long after the run, and possibly after
 * the field has been edited to something else.
 */
let ranAgainst = "";

function setWalletState(message: string, tone?: "error" | "ready"): void {
	walletState.textContent = message;
	if (tone === undefined) {
		walletState.removeAttribute("data-tone");
	} else {
		walletState.dataset.tone = tone;
	}
}

/**
 * Enable Run only when both preconditions hold, and say which one does not.
 *
 * A run needs a contract to assess and a wallet to sign with, and an
 * earlier version gated the button on the wallet alone. Someone who pasted
 * an address then found a disabled button with nothing explaining why — the
 * page knew the reason and kept it to itself. The label carries the missing
 * precondition so the control explains its own state.
 */
function refreshRunButton(): void {
	const hasContract = looksLikeContractId(contractInput.value);
	const hasWallet = connected !== null;
	runButton.disabled = !(hasContract && hasWallet);

	if (!hasContract && !hasWallet) {
		runButton.textContent = "Paste a contract, connect a wallet";
	} else if (!hasContract) {
		runButton.textContent = "Paste a contract ID";
	} else if (!hasWallet) {
		runButton.textContent = "Connect a wallet to run";
	} else {
		runButton.textContent = "Run 16 checks";
	}
}

/**
 * Enough XLM above the reserve for a full run's fees. A run signs about
 * fifteen transactions at roughly 0.01–0.02 XLM each; one XLM leaves room.
 */
const MIN_SPENDABLE = STROOPS_PER_XLM;

/**
 * Why this wallet cannot pay for a run, or `undefined` if it can.
 *
 * A wallet holding exactly its reserve looks funded in Freighter — it
 * shows 1 XLM — yet every write it signs is refused by the network as
 * `tx_insufficient_balance`, and the run reports checks that did not
 * complete. Checked before anything is signed, and said in the wallet's
 * terms. Friendbot funds only new accounts, so an existing one needs XLM
 * sent to it.
 */
async function xlmShortfall(address: string): Promise<string | undefined> {
	const spendable = await spendableXlm(TESTNET_RPC, address);
	if (spendable === null) {
		// Friendbot creates an account; it cannot top one up, which is why
		// this case gets its own advice rather than the shortfall below.
		return "This wallet's account does not exist on testnet yet, so it cannot pay for anything. Fund it with Friendbot — Freighter offers “Fund with Friendbot” for a new testnet account — then run again.";
	}
	if (spendable >= MIN_SPENDABLE) {
		return undefined;
	}
	const shown = (Number(spendable < 0n ? 0n : spendable) / 1e7).toFixed(2);
	return `This wallet has ${shown} XLM available above the reserve every Stellar account must keep, and each write costs a fee. Send it at least 1 testnet XLM from another account — or create a new account in Freighter and fund it with Friendbot — then run again.`;
}

/**
 * The faucet button belongs to the demo token only, and needs a wallet to
 * receive the units — so it shows exactly when both hold. Hidden while a
 * run is active: a faucet claim mid-run would move balances the checks are
 * measuring (see the guard in its click handler).
 */
function refreshFaucet(): void {
	faucetButton.hidden =
		running || !(isDemoContract(contractInput.value) && connected !== null);
}

// Typing an address is half the precondition, so the button tracks it.
contractInput.addEventListener("input", () => {
	contractInput.removeAttribute("aria-invalid");
	refreshRunButton();
	refreshFaucet();
});

useDemoButton.addEventListener("click", () => {
	contractInput.value = DEMO_CONTRACT;
	// Through the same path as typing, so every dependent control updates.
	contractInput.dispatchEvent(new Event("input"));
	setWalletState(
		connected === null
			? "Demo token selected. Connect Freighter, then get test VULN from the faucet."
			: `Demo token selected. Get ${DEMO_FAUCET_UNITS} test VULN if this wallet has none, then run.`,
	);
});

faucetButton.addEventListener("click", async () => {
	const holder = connected;
	if (holder === null) {
		return;
	}
	// Same guard as the run handler: hidden controls can still be reached
	// (keyboard, automation), and a claim landing mid-run would move a
	// balance a check is measuring.
	if (running) {
		return;
	}
	faucetButton.disabled = true;
	faucetButton.textContent = "Approve in Freighter…";
	try {
		await requireTestnet();
		const feeProblem = await xlmShortfall(holder);
		if (feeProblem !== undefined) {
			setWalletState(feeProblem, "error");
			return;
		}
		const target = {
			contractId: contractInput.value,
			rpcUrl: TESTNET_RPC,
			networkPassphrase: TESTNET_PASSPHRASE,
		};
		await claimDemoTokens(target, holder);
		const held = await tokenBalance(target, holder);
		setWalletState(
			`Received ${DEMO_FAUCET_UNITS} units of VULN${held === undefined ? "" : ` — this wallet now holds ${held}`}. Run the checks.`,
			"ready",
		);
	} catch (error) {
		setWalletState(
			error instanceof Error ? error.message : String(error),
			"error",
		);
	} finally {
		faucetButton.disabled = false;
		faucetButton.textContent = `Get ${DEMO_FAUCET_UNITS} test VULN`;
	}
});

/**
 * A wallet on the wrong network would sign transactions this page then
 * submits to testnet, which fails in a way that looks like a contract
 * problem. Refusing here keeps that out of the report.
 */
async function requireTestnet(): Promise<void> {
	const network = await walletNetwork();
	if (network.networkPassphrase !== TESTNET_PASSPHRASE) {
		throw new WalletError(
			`Freighter is on ${network.network}. Switch it to Testnet — this tool submits to testnet, and signing for another network would fail in ways that look like contract faults.`,
		);
	}
}

connectButton.addEventListener("click", async () => {
	connectButton.disabled = true;
	try {
		// `connect()` checks the extension is installed before anything else,
		// then opens Freighter's approval dialog.
		setWalletState(
			"Waiting for Freighter — approve the request in the extension.",
		);
		const address = await connect();
		await requireTestnet();
		connected = address;
		setWalletState(`Connected as ${address}`, "ready");
		refreshRunButton();
		refreshFaucet();
		connectButton.textContent = "Reconnect";
	} catch (error) {
		connected = null;
		refreshRunButton();
		refreshFaucet();
		setWalletState(
			error instanceof Error ? error.message : String(error),
			"error",
		);
	} finally {
		connectButton.disabled = false;
	}
});

/**
 * One row of a live run, in the same shape `Report.astro` renders at build
 * time.
 *
 * The class names and the `data-v` attribute are deliberately identical to
 * that component's, because its stylesheet is global and governs both. An
 * earlier version emitted `.glyph`, `.row-id` and `.row-actual` against a
 * stylesheet that only knew `.g`, `.rid` and `.said` — both rendered, and
 * only the recorded run looked like the product.
 *
 * `landing` is the one class the server-rendered rows do not carry: those
 * are already on screen when the page loads, and animating them in would
 * hide the argument until the animation finished.
 */
function renderRow(result: CheckResult): HTMLLIElement {
	const row = document.createElement("li");
	row.className = "row landing";
	row.dataset.v = result.status;

	const glyph = document.createElement("span");
	glyph.className = "g";
	glyph.textContent = STATUS_GLYPH[result.status];
	// The glyph is decoration for a screen reader; the row's own words carry
	// the meaning, so it is not announced twice.
	glyph.setAttribute("aria-hidden", "true");

	// Same split as the recorded report: member, then the case dimmed, with
	// the full id kept as the tooltip. A live row that still printed the
	// `sep41-` prefix would be the one place the two surfaces disagree.
	const id = document.createElement("span");
	id.className = "rid";
	id.title = result.id;
	const shown = displayId(result.id);
	const member = document.createElement("span");
	member.className = "member";
	member.textContent = shown.member;
	id.append(member);
	if (shown.qualifier !== undefined) {
		const qualifier = document.createElement("span");
		qualifier.className = "qual";
		qualifier.textContent = shown.qualifier;
		id.append(qualifier);
	}

	const actual = document.createElement("span");
	actual.className = "said";
	// In the browser's words: no OWNER_SECRET here, only a wallet and a
	// counterparty field. The exports keep the suite's own wording.
	actual.textContent = forBrowser(result.actual);
	// A skipped row is this run failing, and "check did not complete" alone
	// left the visitor nothing to act on — a rejected Freighter prompt and a
	// dropped connection looked identical. The reason goes on the row itself
	// (first line, trimmed), and in full in the drawer below.
	const failure = result.evidence.error;
	if (result.status === "SKIPPED" && failure !== undefined && failure !== "") {
		const firstLine = failure.split("\n")[0] ?? failure;
		const reason =
			explainFailure(failure) ??
			(firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine);
		actual.textContent = `${forBrowser(result.actual)}: ${reason}`;
	}

	const why = document.createElement("button");
	why.className = "why";
	why.type = "button";
	why.textContent = "WHY";
	why.setAttribute("aria-expanded", "false");

	const drawer = document.createElement("div");
	drawer.className = "drawer";
	drawer.hidden = true;
	// `live-` prefixed: the recorded report already owns `drawer-<id>` for
	// the same check ids, and a duplicate would point `aria-controls` at the
	// wrong element.
	drawer.id = `live-drawer-${result.id}`;
	why.setAttribute("aria-controls", drawer.id);

	const list = document.createElement("dl");
	const expectedTerm = document.createElement("dt");
	expectedTerm.textContent = "EXPECTED";
	const expectedValue = document.createElement("dd");
	expectedValue.textContent = result.expected;
	list.append(expectedTerm, expectedValue);

	if (failure !== undefined && failure !== "") {
		const errorTerm = document.createElement("dt");
		errorTerm.textContent =
			result.status === "SKIPPED" ? "WHY IT DID NOT COMPLETE" : "ERROR";
		const errorValue = document.createElement("dd");
		errorValue.className = "error-text";
		errorValue.textContent = failure;
		list.append(errorTerm, errorValue);
	}

	// A transaction hash is the one piece of evidence a reader can take to
	// an explorer and check for themselves, so it is a link rather than text.
	const handle = result.evidence.txHash;
	if (handle !== undefined && handle !== "") {
		const txTerm = document.createElement("dt");
		txTerm.textContent = "TRANSACTION";
		const txValue = document.createElement("dd");
		const link = document.createElement("a");
		link.href = `https://stellar.expert/explorer/testnet/tx/${handle}`;
		link.rel = "noopener noreferrer";
		link.target = "_blank";
		link.textContent = handle;
		txValue.append(link);
		list.append(txTerm, txValue);
	}

	// The same link the recorded rows carry: from a live verdict to the
	// reasoning behind it.
	const more = document.createElement("a");
	more.className = "more-link";
	more.href = `/checks#${checkAnchor(result.id)}`;
	more.textContent = "What this check proves";

	drawer.append(list, more);

	why.addEventListener("click", () => {
		const open = !drawer.hidden;
		drawer.hidden = open;
		why.setAttribute("aria-expanded", String(!open));
		why.textContent = open ? "WHY" : "HIDE";
	});

	row.append(glyph, id, actual, why, drawer);
	return row;
}

function renderSummary(
	results: readonly CheckResult[],
	exitCode: number,
): void {
	const tally = (status: CheckResult["status"]) =>
		results.filter((result) => result.status === status).length;
	summary.textContent =
		`${tally("PASS")} pass, ${tally("FAIL")} fail, ${tally("SKIPPED")} skipped, ` +
		`${tally("UNVERIFIABLE")} unverifiable, ${tally("NOT_IMPLEMENTED")} not implemented ` +
		`(${results.length} checks) — exit ${exitCode}`;
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();

	// A disabled button does not block an Enter-submit from a focused
	// field, and the run is long enough to invite a second one. Two
	// concurrent runs interleave their rows and their progress counts into
	// the same elements, so the flag guards the handler rather than the
	// control.
	if (running) {
		return;
	}
	if (connected === null) {
		setWalletState(
			"Connect Freighter first — the eleven checks that write need a wallet to sign them.",
			"error",
		);
		return;
	}

	const contractId = contractInput.value.trim();
	if (!looksLikeContractId(contractId)) {
		contractInput.setAttribute("aria-invalid", "true");
		setWalletState(
			"That does not look like a contract id — 56 characters beginning with C.",
			"error",
		);
		return;
	}
	contractInput.removeAttribute("aria-invalid");

	const spenderRaw = spenderInput.value.trim();
	if (spenderRaw !== "" && !looksLikeAccountId(spenderRaw)) {
		spenderInput.setAttribute("aria-invalid", "true");
		setWalletState(
			"The counterparty must be an account address — 56 characters beginning with G — or empty.",
			"error",
		);
		return;
	}
	spenderInput.removeAttribute("aria-invalid");

	running = true;
	runButton.disabled = true;
	runButton.textContent = "Running…";
	refreshFaucet();
	report.hidden = false;
	rows.replaceChildren();
	summary.textContent = "";
	progress.textContent = "Preparing…";
	setWalletState(`Connected as ${connected}`, "ready");

	// `ranAgainst` and `lastResults` describe one run between them, and the
	// copy buttons read both. Invalidating the pair on entry — rather than
	// setting one here and the other on success — removes the window where
	// a failed rerun would leave the previous run's results attributed to
	// the contract that was just attempted and never assessed.
	lastResults = [];
	lastRanAt = "";
	ranAgainst = contractId;

	try {
		// The wallet's network is checked at connect time, but a visitor can
		// switch Freighter to mainnet with the page still open. Signing then
		// produces failures that look exactly like contract faults, which is
		// the confusion this check exists to prevent — so it is re-asserted
		// per run, not once per session.
		await requireTestnet();

		// Same reasoning for identity. Freighter can switch accounts while
		// the page is open, and the run signs as whoever is active now — so
		// a balance read for the connected address and a transaction signed
		// by a different one would disagree, and the check would report the
		// contract for it.
		const signingAs = await connect();
		if (signingAs !== connected) {
			connected = signingAs;
			setWalletState(`Connected as ${signingAs}`, "ready");
		}

		/*
		 * A wallet with none of the token cannot exercise a single write, and
		 * running anyway printed eleven rows of "?" that read as a broken
		 * tool. Said once, before anything is signed. On the demo token the
		 * fix is one click away, so the run stops and points at it; on any
		 * other token the reads are still worth having, so it runs and says
		 * what to expect.
		 */
		progress.textContent = "Reading this wallet's balances…";
		const feeProblem = await xlmShortfall(signingAs);
		if (feeProblem !== undefined) {
			report.hidden = true;
			progress.textContent = "";
			setWalletState(feeProblem, "error");
			return;
		}
		const target = {
			contractId,
			rpcUrl: TESTNET_RPC,
			networkPassphrase: TESTNET_PASSPHRASE,
		};
		const held = await tokenBalance(target, signingAs);
		// A full run spends five units, so on the demo token anything short
		// of that runs dry partway and the last checks report an empty
		// account. Topping up is one click, so the page asks for it first.
		if (
			held !== undefined &&
			held < BigInt(DEMO_FAUCET_UNITS) &&
			isDemoContract(contractId)
		) {
			report.hidden = true;
			progress.textContent = "";
			refreshFaucet();
			setWalletState(
				held === 0n
					? `This wallet holds no VULN yet, so the writes have nothing to move. Press "Get ${DEMO_FAUCET_UNITS} test VULN", then run again.`
					: `This wallet holds ${held} VULN and a full run spends ${DEMO_FAUCET_UNITS}. Press "Get ${DEMO_FAUCET_UNITS} test VULN" to top up, then run again.`,
				"error",
			);
			return;
		}
		/*
		 * Any other token, and none of it in the wallet: eleven of sixteen
		 * checks cannot run, and the result is a wall of "?". The recorded
		 * fixture on the home page is the usual case — its mint is
		 * admin-only — so the page stops once, says why, and points at the
		 * demo token. Pressing Run again for the same pair runs the reads.
		 */
		const pair = `${contractId}:${signingAs}`;
		if (held === 0n && readsOnlyConfirmed !== pair) {
			readsOnlyConfirmed = pair;
			report.hidden = true;
			progress.textContent = "";
			setWalletState(
				"This wallet holds none of this token, so the eleven checks that write cannot run. For a full run, press “Use the demo token” above — its faucet gives any wallet what a run needs. Or press Run again to run the reads only.",
				"error",
			);
			return;
		}
		if (held === 0n) {
			progress.textContent =
				"Running the reads only — this wallet holds none of this token.";
		}

		const outcome = await runChecks(
			{
				...target,
				ownerAddress: signingAs,
				...(spenderRaw === "" ? {} : { spenderAddress: spenderRaw }),
			},
			(completed, total) => {
				progress.textContent = `${completed} of ${total} checks complete — approve each prompt in Freighter.`;
			},
			(stage) => {
				progress.textContent = stage;
			},
		);
		lastResults = outcome.results;
		lastRanAt = new Date().toISOString();
		progress.textContent = "";
		rows.replaceChildren(...outcome.results.map(renderRow));
		renderSummary(outcome.results, outcome.exitCode);
	} catch (error) {
		// A throw here is the run never starting — a bad address, an
		// unreachable node, a refused connection. It is not a verdict, so it
		// is reported as a failure of this page rather than of the contract.
		progress.textContent = "";
		summary.textContent = "";
		setWalletState(
			`Could not run: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	} finally {
		running = false;
		// Back to whichever precondition state now applies, rather than
		// unconditionally enabled: a run does not change whether the page
		// still has a contract and a wallet.
		refreshRunButton();
		refreshFaucet();
	}
});

async function copy(text: string, button: HTMLButtonElement): Promise<void> {
	const original = button.textContent ?? "";
	try {
		await navigator.clipboard.writeText(text);
		button.textContent = "Copied";
	} catch {
		// Clipboard access is denied in some contexts, and silently doing
		// nothing would read as a broken button.
		button.textContent = "Copy blocked";
	}
	setTimeout(() => {
		button.textContent = original;
	}, 1500);
}

copyMarkdown.addEventListener("click", () => {
	// Narrate rather than bare-return: every other precondition on this page
	// says what is missing, and a button that does nothing when pressed is
	// indistinguishable from one that is broken.
	if (lastResults.length === 0) {
		setWalletState("Nothing to copy yet — run the checks first.", "error");
		return;
	}
	void copy(
		renderMarkdownReport({
			standard: "SEP-41",
			contractId: ranAgainst,
			ranAt: lastRanAt,
			rpcUrl: TESTNET_RPC,
			results: lastResults,
		}),
		copyMarkdown,
	);
});

copyJson.addEventListener("click", () => {
	// Narrate rather than bare-return: every other precondition on this page
	// says what is missing, and a button that does nothing when pressed is
	// indistinguishable from one that is broken.
	if (lastResults.length === 0) {
		setWalletState("Nothing to copy yet — run the checks first.", "error");
		return;
	}
	void copy(
		renderJsonReport({
			standard: "SEP-41",
			contractId: ranAgainst,
			ranAt: lastRanAt,
			rpcUrl: TESTNET_RPC,
			results: lastResults,
		}),
		copyJson,
	);
});

/**
 * Say up front if Freighter is missing, so the visitor finds out before
 * filling in the form rather than after pressing Connect. Uses the library's
 * own installation check, which returns promptly whether or not the
 * extension is there.
 */
void isFreighterInstalled().then((present) => {
	if (!present) {
		setWalletState(
			"Freighter not detected. Install it from freighter.app and reload — the eleven checks that write need a wallet to sign them.",
		);
	}
});

// The markup ships the button disabled; this gives it the label that says
// why, and re-syncs it if the browser restored a typed address on reload.
refreshRunButton();
