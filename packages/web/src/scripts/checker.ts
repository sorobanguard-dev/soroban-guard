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
import { mayStillLand, owedSendBack } from "./owed.ts";
import {
	type Cleanup,
	claimDemoTokens,
	looksLikeAccountId,
	looksLikeContractId,
	type RunRequest,
	runChecks,
	type Settlement,
	STROOPS_PER_XLM,
	spendableXlm,
	tokenBalance,
	transactionStatus,
	type Unresolved,
} from "./run.ts";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";

// The glyphs come from core, not a copy here: one export, one set of
// symbols, so the page and the CLI print the same one for each status.

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
// `el()` would find the section, cast it to a button, and leave the
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
 * A faucet claim waiting in Freighter or on the ledger. The run guard's
 * mirror image: `running` keeps a claim from landing mid-run, and this
 * keeps a run — or a second claim — from starting while one is in flight,
 * since a claim that lands mid-run moves the balance a check is measuring.
 */
let claiming = false;

/**
 * A retried send-back from the temporary account, in flight. Blocks a new
 * run for the same reason `claiming` does: units landing in the wallet
 * mid-run move the balance a check is measuring.
 */
let returning = false;

/**
 * The send-back still owed from the last run, while the page holds the
 * temporary account's key. The retry button lives in `progress`, which a
 * new run overwrites — so without this, Run would drop the only reference
 * to the key and strand the units.
 */
const owed = owedSendBack<Cleanup>();

/**
 * The oldest ledger the page's token reads and writes must describe: the
 * latest by which a transaction this page knows of may have moved the
 * wallet's balance. Raised by every ledger a run, a status check or a
 * faucet claim reports a transaction settling in, and by a cleanup's
 * `closedAfterDeadline` (see `Cleanup`). An RPC backend behind it would
 * answer with state from before that transaction.
 */
let readsFrom: number | undefined;

/** Raise `readsFrom` to `ledger`, when there is one. */
function holdFrom(ledger: number | undefined): void {
	if (ledger !== undefined) {
		readsFrom = Math.max(readsFrom ?? 0, ledger);
	}
}

/** `request`, held to `readsFrom` as it stands now. */
function heldTo<T extends object>(request: T): T & { minLedger?: number } {
	return readsFrom === undefined
		? request
		: { ...request, minLedger: readsFrom };
}

/** The demo token, on the network the page uses. */
type Target = Pick<RunRequest, "contractId" | "rpcUrl" | "networkPassphrase">;

/**
 * A transaction the page sent and could not confirm, while it may still
 * land and move the wallet's balance under a run's checks or a claim's
 * read: a faucet claim, or a run's write that no cleanup waits on. Run and
 * the faucet wait, and the control it blocks looks it up again (see
 * `showSettlement`) until it lands, fails, or can no longer land: the
 * faucet button for a claim, Run for a run's write.
 */
let waitingOn:
	| {
			readonly kind: Waiting;
			readonly tx: Unresolved;
			readonly target: Target;
			readonly holder: string;
	  }
	| undefined;

type Waiting = "claim" | "write";

/** How the page names a transaction of each kind, and the button that checks it. */
const WAITING = {
	claim: { name: "The faucet transaction", check: "Check the faucet claim" },
	write: {
		name: "The run's transaction",
		check: "Check the last run's transaction",
	},
} as const;

/** What is in flight, as the reason another action must wait, or `undefined`. */
function busy(): string | undefined {
	if (running) {
		return "A run is in progress — wait for it to finish.";
	}
	if (claiming) {
		return "A faucet claim is in progress — wait for it to land.";
	}
	if (returning) {
		return "Units are still being sent back from the last run — wait for that to finish.";
	}
	return undefined;
}

/**
 * Why an action that may send a transaction cannot start now, or
 * `undefined` when it can: something in flight, or a transaction the page
 * sent that may still land and move what the new one reads. Run, a new
 * faucet claim and a cleanup's retry all ask this. `own` is the pending
 * transaction the action itself settles, which never blocks it; a lookup
 * that sends nothing asks only `busy`.
 */
function blockedBy(own?: "cleanup"): string | undefined {
	const inFlight = busy();
	if (inFlight !== undefined) {
		return inFlight;
	}
	if (waitingOn !== undefined) {
		const { name, check } = WAITING[waitingOn.kind];
		return `${name} may still land — press “${check}” first.`;
	}
	const owing = owed.pending();
	if (own !== "cleanup" && owing !== undefined && mayStillLand(owing)) {
		return `A transaction the last run's cleanup waits on may still land — press “${retryLabel(owing)}” first.`;
	}
	return undefined;
}

/** The button that tries a cleanup again, named for what it will do. */
function retryLabel(cleanup: Cleanup): string {
	return "failed" in cleanup && cleanup.pendingTxHash !== undefined
		? "Check transaction status"
		: "Try sending them back again";
}

/**
 * Say what happened to the temporary account's units — and, while the
 * page still holds that account's key, offer to try again. The key lives
 * only in this tab; without a retry, a failed send-back would leave the
 * units unreachable.
 */
function showCleanup(cleanup: Cleanup): void {
	owed.owe(
		"failed" in cleanup && cleanup.retry !== undefined ? cleanup : undefined,
	);
	holdFrom(cleanup.settledThrough);
	if ("failed" in cleanup) {
		holdFrom(cleanup.closedAfterDeadline);
	}
	// While a transaction it waits on may still land, Run and the faucet wait.
	refreshRunButton();
	refreshFaucet();
	if ("returned" in cleanup) {
		progress.textContent =
			cleanup.returned > 0n
				? `The temporary second account sent ${cleanup.returned} unit${cleanup.returned === 1n ? "" : "s"} back to your wallet.`
				: "";
		return;
	}
	progress.textContent = `The temporary second account could not send its units back to your wallet: ${cleanup.failed}`;
	const retry = cleanup.retry;
	if (retry === undefined) {
		return;
	}
	const button = document.createElement("button");
	button.type = "button";
	button.className = "retry-action";
	button.textContent = retryLabel(cleanup);
	button.addEventListener("click", async () => {
		// The retry may send the units again, so it waits by the same rule
		// as Run and the faucet: on anything in flight, and on any other
		// transaction that may still land.
		const blocked = blockedBy("cleanup");
		if (blocked !== undefined) {
			// Silent-button class, same as copy/no-wallet: a control that
			// visibly does nothing reads as broken, so it says why.
			setWalletState(blocked);
			return;
		}
		returning = true;
		refreshRunButton();
		refreshFaucet();
		button.disabled = true;
		button.textContent = "Sending back…";
		try {
			showCleanup(await retry());
		} finally {
			returning = false;
			refreshRunButton();
			refreshFaucet();
		}
	});
	progress.append(" ", button);
}

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
 * A run needs a contract to assess and a wallet to sign with. The label
 * carries the missing precondition, so the control explains its own
 * state.
 */
function refreshRunButton(): void {
	const hasContract = looksLikeContractId(contractInput.value);
	const hasWallet = connected !== null;
	const settling = mayStillLand(owed.pending());
	// A run's write that may still land is looked up from Run itself.
	const write = waitingOn?.kind === "write";
	const claimPending = waitingOn?.kind === "claim";
	runButton.disabled =
		claiming ||
		returning ||
		claimPending ||
		(!write && (settling || !(hasContract && hasWallet)));

	if (claiming) {
		runButton.textContent = "Waiting for the faucet…";
	} else if (returning) {
		runButton.textContent = "Sending units back…";
	} else if (write) {
		runButton.textContent = WAITING.write.check;
	} else if (claimPending) {
		runButton.textContent = "Check the faucet claim first";
	} else if (settling) {
		runButton.textContent = "Check the transaction status first";
	} else if (!hasContract && !hasWallet) {
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
 * Enough XLM above the reserve for a full run's fees, with room to spare.
 *
 * A run signs about fifteen transactions at roughly 0.01–0.02 XLM each —
 * the one observed on testnet charged 0.0134 — so the worst case is near
 * 0.3 XLM. Half an XLM covers that with margin, and no more is asked: an
 * existing wallet cannot be topped up by Friendbot, so a threshold above
 * the need turns away wallets that can pay, a dead end, not a nudge.
 */
const MIN_SPENDABLE = STROOPS_PER_XLM / 2n;

/**
 * Why this wallet cannot pay for a run, or `undefined` if it can.
 *
 * A wallet holding exactly its reserve looks funded in Freighter — it
 * shows 1 XLM — yet every write it signs is refused by the network as
 * `tx_insufficient_balance`, and the run reports checks that did not
 * complete. Checked before anything is signed, and said in the wallet's
 * terms. Friendbot funds only new accounts, so an existing one needs XLM
 * sent to it.
 *
 * Not held to `readsFrom`: no verdict rests on this estimate, and a
 * transaction a cleanup left open moves it by little more than a fee.
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
	return `This wallet has ${shown} XLM available above the reserve every Stellar account must keep, and each write costs a fee. A full run needs about half an XLM. Send it some testnet XLM from another account — or create a new account in Freighter and fund it with Friendbot — then run again.`;
}

/**
 * The faucet button belongs to the demo token only, and needs a wallet to
 * receive the units — so it shows exactly when both hold. Hidden while a
 * run is active: a faucet claim mid-run would move balances the checks are
 * measuring (see the guard in its click handler). Hidden during a send-back
 * retry too, whose units would land under the claim's balance read.
 *
 * While a claim may still land (`waitingOn`), the button looks it up
 * instead, and shows whatever the contract field now says: Run waits on
 * that claim, so the way to settle it must stay in reach. While a run's
 * write may still land, it is hidden, as for a cleanup's.
 */
function refreshFaucet(): void {
	const claim = waitingOn?.kind === "claim";
	faucetButton.hidden = claim
		? returning
		: running ||
			returning ||
			waitingOn !== undefined ||
			mayStillLand(owed.pending()) ||
			!(isDemoContract(contractInput.value) && connected !== null);
	if (!claiming) {
		faucetButton.disabled = false;
		faucetButton.textContent = claim
			? WAITING.claim.check
			: `Get ${DEMO_FAUCET_UNITS} test VULN`;
	}
}

/**
 * Say what a transaction the page sent came to, and hold the page's reads
 * to the ledger it settled in. One that may still land opens `waitingOn`;
 * one that can no longer land holds the reads to the ledger that rules it
 * out, whether or not it landed before then. `txHash` names a settled one.
 */
async function showSettlement(
	kind: Waiting,
	settlement: Settlement,
	target: Target,
	holder: string,
	txHash = "",
): Promise<void> {
	waitingOn = undefined;
	const { name, check } = WAITING[kind];
	if ("unresolved" in settlement) {
		const tx = settlement.unresolved;
		const past = tx.closedAfterDeadline;
		if (past === undefined) {
			waitingOn = { kind, tx, target, holder };
			setWalletState(
				`${name} ${tx.txHash} was sent but is not confirmed yet, and it may still land. Run waits until “${check}” finds it landed, failed or unable to land.`,
				"error",
			);
			return;
		}
		holdFrom(past);
		const held =
			kind === "claim" ? await tokenBalance(heldTo(target), holder) : undefined;
		setWalletState(
			`${name} ${tx.txHash} can no longer land: ledger ${past} closed after its deadline. Whether it landed before then is not known${held === undefined ? "" : `; ${holder} holds ${held} VULN`}.`,
			"ready",
		);
		return;
	}
	if ("failed" in settlement) {
		holdFrom(settlement.ledger);
		if (kind === "claim") {
			setWalletState(
				`The faucet call did not go through: ${settlement.failed}`,
				"error",
			);
		} else {
			setWalletState(
				`${name} ${txHash} did not go through: ${settlement.failed}.`,
				"ready",
			);
		}
		return;
	}
	holdFrom(settlement.landed);
	if (kind === "write") {
		setWalletState(
			`${name} ${txHash} landed in ledger ${settlement.landed}.`,
			"ready",
		);
		return;
	}
	const held = await tokenBalance(heldTo(target), holder);
	setWalletState(
		// The wallet the claim was for, which a delayed check may no longer be
		// the one connected.
		`Received ${DEMO_FAUCET_UNITS} units of VULN${held === undefined ? "" : ` — ${holder} now holds ${held}`}. Run the checks.`,
		"ready",
	);
}

// Typing an address is half the precondition, so the button tracks it.
contractInput.addEventListener("input", () => {
	contractInput.removeAttribute("aria-invalid");
	refreshRunButton();
	refreshFaucet();
	// The likeliest wrong paste for a classic asset: its issuer's G-address
	// sits right beside it everywhere the asset is listed, and it is the
	// same length. A greyed-out button said nothing about why.
	if (looksLikeAccountId(contractInput.value)) {
		contractInput.setAttribute("aria-invalid", "true");
		setWalletState(
			"That is an account address (it starts with G), not a token contract. A token's contract ID starts with C — for a classic asset like USDC, use its Stellar Asset Contract ID, not the issuer's address.",
			"error",
		);
	}
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
	// Same guard as the run handler: hidden controls can still be reached
	// (keyboard, automation), and a claim landing mid-run would move a
	// balance a check is measuring. A send-back retry in flight would do the
	// same to the balance this claim reads when it lands, and so would a
	// transaction the cleanup waits on while it can still land. A claim
	// that may still land is looked up again, which sends nothing; a new
	// one is made by the rule every action that sends follows.
	const open = waitingOn?.kind === "claim" ? waitingOn : undefined;
	const blocked = open === undefined ? blockedBy() : busy();
	const holder = open?.holder ?? connected;
	if (blocked !== undefined || holder === null) {
		return;
	}
	claiming = true;
	refreshRunButton();
	faucetButton.disabled = true;
	faucetButton.textContent =
		open === undefined ? "Approve in Freighter…" : "Checking the claim…";
	try {
		if (open !== undefined) {
			await showSettlement(
				"claim",
				await transactionStatus(open.target, open.tx),
				open.target,
				open.holder,
				open.tx.txHash,
			);
			return;
		}
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
		await showSettlement(
			"claim",
			await claimDemoTokens(heldTo(target), holder),
			target,
			holder,
		);
	} catch (error) {
		setWalletState(
			error instanceof Error ? error.message : String(error),
			"error",
		);
	} finally {
		claiming = false;
		refreshRunButton();
		refreshFaucet();
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
 * that component's, because its stylesheet is global and governs both:
 * rows under other names would render unstyled, and only the recorded
 * run would look like the product.
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
	// A skipped row is this run failing, and the visitor needs its reason
	// to act on: a rejected Freighter prompt and a dropped connection are
	// different things to fix. The reason goes on the row itself (first
	// line, trimmed), and in full in the drawer below. Trimmed once, here,
	// so an error that opens with a newline still gives a reason, and one
	// of whitespace alone opens no drawer.
	const failure = result.evidence.error?.trim() ?? "";
	if (result.status === "SKIPPED" && failure !== "") {
		// Trimmed, so the first line is the first thing the error says.
		const [firstLine = ""] = failure.split("\n");
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

	if (failure !== "") {
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
	// Run looks up a run's write that may still land, instead of running:
	// a lookup that sends nothing, so only what is in flight stops it.
	const write = waitingOn?.kind === "write" ? waitingOn : undefined;
	if (write !== undefined && busy() === undefined) {
		running = true;
		runButton.disabled = true;
		runButton.textContent = "Checking the last run's transaction…";
		refreshFaucet();
		try {
			await showSettlement(
				"write",
				await transactionStatus(write.target, write.tx),
				write.target,
				write.holder,
				write.tx.txHash,
			);
		} catch (error) {
			setWalletState(
				error instanceof Error ? error.message : String(error),
				"error",
			);
		} finally {
			running = false;
			refreshRunButton();
			refreshFaucet();
		}
		return;
	}
	// The suite sends transactions, so it starts by the rule every such
	// action follows. Leaving a cleanup's units behind does not stop its
	// transaction landing either.
	const blocked = blockedBy();
	if (blocked !== undefined) {
		setWalletState(blocked, "error");
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

	// Starting the suite discards the temporary key and its recovery action.
	const owing = owed.pending();
	if (owing !== undefined && owed.onRun() === "warn") {
		setWalletState(
			"failed" in owing && owing.pendingTxHash !== undefined
				? `The last run's cleanup waits on a transaction whose outcome is not yet known. Press “${retryLabel(owing)}” below — or press Run again to start a new run, which discards the temporary account's key: the page can then neither settle that transaction nor send the units back.`
				: `The temporary second account still holds units from the last run. Press “${retryLabel(owing)}” below — or press Run again to start a new run, which discards that account's key and leaves the units there.`,
			"error",
		);
		return;
	}

	let suiteStarted = false;
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
		const target = heldTo({
			contractId,
			rpcUrl: TESTNET_RPC,
			networkPassphrase: TESTNET_PASSPHRASE,
		});
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

		// Only now is an owed send-back given up: every gate above can still
		// stop the run, and a stopped run must leave the retry in place.
		owed.abandon();
		suiteStarted = true;
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
		holdFrom(outcome.settledThrough);
		lastResults = outcome.results;
		lastRanAt = new Date().toISOString();
		progress.textContent = "";
		rows.replaceChildren(...outcome.results.map(renderRow));
		renderSummary(outcome.results, outcome.exitCode);
		// The temporary second account's units go back to the holder; say
		// whether they did, since they were the visitor's to begin with.
		if (outcome.cleanup !== undefined) {
			showCleanup(outcome.cleanup);
		} else if (outcome.spenderSetupFailed !== undefined) {
			progress.textContent = `The page could not set up a second account (${outcome.spenderSetupFailed}). See the report for which checks could run.`;
		}
		// No cleanup waits on it, so the page does: the next run waits until
		// it can no longer land.
		if (outcome.unresolvedWrite !== undefined) {
			await showSettlement(
				"write",
				{ unresolved: outcome.unresolvedWrite },
				target,
				signingAs,
			);
		}
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
		// Stopped before the suite: "Preparing…" replaced the retry button,
		// but the key is still held, so offer it again.
		const stillOwed = owed.pending();
		if (!suiteStarted && stillOwed !== undefined) {
			// The reads-only gate hides the report, and the retry lives in it.
			report.hidden = false;
			showCleanup(stillOwed);
		}
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
