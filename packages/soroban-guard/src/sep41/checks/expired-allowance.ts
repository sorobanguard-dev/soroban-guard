/**
 * `transfer_from` must refuse an allowance that has expired.
 *
 * SEP-41's `approve` takes a `live_until_ledger` alongside the amount, so a
 * grant is a permission with a deadline rather than a standing one. A
 * contract that stores the amount and ignores the deadline leaves every
 * approval permanent: a spender authorized once for a single purchase can
 * come back a year later and spend again. Nothing a reader can observe
 * distinguishes the two, because `allowance()` returns the amount alone and
 * never the ledger it dies at.
 *
 * That invisibility is why this check has to *create* the condition it
 * tests. Every other negative check reads a premise and then violates it;
 * this one approves a grant with a deliberately short life, waits for the
 * ledger to pass it, and only then spends. It is the only check in the
 * suite that waits on wall-clock time, and the wait is bounded — if the
 * network does not advance, the run reports UNVERIFIABLE rather than
 * hanging or guessing.
 *
 * The grant is not recorded in `ctx.establishedAllowances`. That registry
 * means "this run watched it land, so it cannot have expired" — precisely
 * the opposite of what is built here, and registering it would teach the
 * `_from` checks to treat an expired grant as fresh.
 */
import { addressArg, amountArg, submitWrite } from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import type { Sep41Context } from "../context.ts";
import { submitApproval } from "./approve.ts";
import { readAllowance, readBalance } from "./quantity.ts";
import {
	inconclusiveResult,
	type RefusalWording,
	readRefusal,
} from "./refusal.ts";
import {
	type CheckMeta,
	ISSUER_SENTINEL_BALANCE,
	isDeclared,
	notImplemented,
	setupEvidence,
	verdictHelpers,
} from "./shared.ts";

const SPEND_AMOUNT = 1n;

/**
 * Ledgers the deliberately short-lived grant is given.
 *
 * One would be tighter, but a submission that takes two ledgers to include
 * would then expire before it applied — the approval itself would fail and
 * the check would learn nothing. Two leaves room for inclusion while still
 * lapsing within seconds.
 */
const SHORT_LIFETIME_LEDGERS = 2;

/**
 * How long to wait for the grant to lapse before giving up.
 *
 * Testnet closes roughly every four to six seconds, so two ledgers is
 * normally ten seconds or less. The ceiling is generous enough to absorb a
 * slow round without turning a stalled network into a hung run.
 */
const MAX_WAIT_MS = 45_000;
const POLL_INTERVAL_MS = 2_000;

const expiredMeta = {
	id: "sep41-transfer_from-expired",
	clause: "SEP-41 §transfer_from",
	layer: "behavior",
	requirement: "required",
} as const satisfies CheckMeta;

const EXPECTED =
	"transfer_from refuses a spend against an allowance whose live_until_ledger has passed";

const WORDING: RefusalWording = {
	attempt: "the expired-allowance spend",
	rule: "an allowance stops working once its ledger has passed",
};

const { unverifiable, failed } = verdictHelpers(expiredMeta, EXPECTED);

/** Wait until the chain is past `target`, or give up. Returns the ledger. */
async function waitForLedger(
	ctx: Sep41Context,
	target: number,
	deadline: number,
): Promise<number | null> {
	// Read, then wait, never the reverse. Checking the clock before the
	// read is what would give up on a window still had: a poll with a
	// second left would report "did not pass" on a ledger that had a second
	// to close in. So every pass reads first, and the wait is trimmed to
	// whatever remains rather than skipped — the deadline stays a real
	// bound, and the loop always ends on a read.
	//
	// Bounded by the deadline rather than by a count, unlike fundAccount's
	// retry: the caller states how long the answer is worth waiting for,
	// and how many polls fit in that is the poll interval's business.
	while (true) {
		const latest = await ctx.server.getLatestLedger();
		if (latest.sequence > target) {
			return latest.sequence;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			return null;
		}
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
		);
	}
}

export const expiredAllowanceCheck = {
	...expiredMeta,
	description:
		"transfer_from() refuses a spend once the allowance's ledger has passed",
	async run(ctx: Sep41Context): Promise<CheckResult> {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		if (!isDeclared(ctx, "transfer_from")) {
			return notImplemented(expiredMeta, "transfer_from", elapsed());
		}
		if (!isDeclared(ctx, "approve")) {
			return unverifiable(
				"the contract declares no approve, so no allowance can be created to expire",
				elapsed(),
			);
		}

		const { owner, spender } = ctx.parties;
		// Both keys: the holder grants, the spender spends.
		if (owner.signer === undefined || spender.signer === undefined) {
			return unverifiable(
				"expired-allowance needs both keys: OWNER_SECRET to grant the allowance and SPENDER_SECRET to attempt the spend",
				elapsed(),
			);
		}
		if (
			owner.signer.address !== owner.address ||
			spender.signer.address !== spender.address
		) {
			return unverifiable(
				"a signer does not match the party it signs for; supply keys for the addresses under test",
				elapsed(),
			);
		}
		if (owner.address === spender.address) {
			return unverifiable(
				"holder and spender are the same address; spending your own balance needs no allowance — set SPENDER_ADDRESS to a different account",
				elapsed(),
			);
		}
		// The spender receives here. A generated address discards its key at
		// exit, so a contract that wrongly allowed the spend would move the
		// unit somewhere unrecoverable.
		if (spender.isThrowaway) {
			return unverifiable(
				"the spender was generated for this run and its key is discarded at exit; set SPENDER_ADDRESS to an account you control before attempting a spend that may succeed",
				elapsed(),
			);
		}

		const holder = await readBalance(ctx, owner.address);
		// A defective balance() is the contract's fault whichever check reads
		// it; balanceCheck FAILs the identical response.
		if (holder.kind === "defect") {
			return failed(
				`${holder.detail}; the premise cannot be established`,
				elapsed(),
				holder.error === "" ? {} : { error: holder.error },
			);
		}
		if (holder.kind !== "value") {
			return unverifiable(
				"holder balance unreadable; cannot establish that there is anything to spend",
				elapsed(),
			);
		}
		if (holder.amount < SPEND_AMOUNT) {
			return unverifiable(
				`the holder has ${holder.amount}; a refusal would say the account is empty rather than anything about expiry`,
				elapsed(),
			);
		}

		const recipient = await readBalance(ctx, spender.address);
		if (recipient.kind === "defect") {
			return failed(
				`${recipient.detail}; the premise cannot be established`,
				elapsed(),
				recipient.error === "" ? {} : { error: recipient.error },
			);
		}
		if (recipient.kind !== "value") {
			return unverifiable(
				`recipient balance unreadable (${recipient.detail}); cannot establish that neither party is the asset issuer`,
				elapsed(),
			);
		}
		if (
			holder.amount === ISSUER_SENTINEL_BALANCE ||
			recipient.amount === ISSUER_SENTINEL_BALANCE
		) {
			return unverifiable(
				"one party is the asset issuer (balance reads i64::MAX); issuer transfers mint or burn rather than move, so the outcome would say nothing about expiry",
				elapsed(),
			);
		}

		// Setup: a grant built to lapse. A failure here says nothing about
		// transfer_from, so it never reaches a verdict.
		const latest = await ctx.server.getLatestLedger();
		const expiresAt = latest.sequence + SHORT_LIFETIME_LEDGERS;
		const approval = await submitApproval(
			ctx,
			SPEND_AMOUNT,
			latest.sequence,
			SHORT_LIFETIME_LEDGERS,
			// Never registered. The registry means "fresh, so a refusal is
			// the contract's answer"; this grant is built to lapse, so
			// registering it would teach transfer_from and burn_from to read
			// an expired allowance as a live one and FAIL a correct contract.
			false,
		);
		if (approval.kind !== "applied") {
			return unverifiable(
				"could not establish a short-lived allowance; approve must work before expiry can be assessed",
				elapsed(),
				setupEvidence(approval),
			);
		}

		// An applied approval is not yet a grant. A contract that accepts
		// `approve` and stores nothing leaves this check testing an
		// allowance that never existed: the spend below is refused for
		// having no grant at all, and a refusal here is the PASS — so the
		// contract would be credited with honouring a deadline it does not
		// implement. SEP-41 reports an absent allowance and an expired one
		// identically, as zero, so only reading it back distinguishes them.
		const granted = await readAllowance(ctx, owner.address, spender.address);
		if (granted.kind === "defect") {
			return failed(
				`${granted.detail}; the grant cannot be confirmed`,
				elapsed(),
				granted.error === "" ? {} : { error: granted.error },
			);
		}
		if (granted.kind !== "value" || granted.amount < SPEND_AMOUNT) {
			return unverifiable(
				granted.kind === "value"
					? `approve was accepted but allowance() reports ${granted.amount}, so there is no live grant to expire; the spend would be refused for having none rather than for the deadline`
					: `approve was accepted but the allowance could not be read back (${granted.detail}), so it is unknown whether a grant exists to expire`,
				elapsed(),
			);
		}

		// The clock starts after setup, not at run start: premise reads and
		// the approval submission cost ledger closes of their own, and
		// charging them to the wait would time out a healthy network after
		// slow setup.
		const deadline = Date.now() + MAX_WAIT_MS;

		// Wait for the deadline to pass. Bounded: a stalled network is a fact
		// about the run, not a verdict about the contract.
		const reached = await waitForLedger(ctx, expiresAt, deadline);
		if (reached === null) {
			return unverifiable(
				`the ledger did not pass ${expiresAt} within ${MAX_WAIT_MS / 1000}s, so the allowance may not have expired yet`,
				elapsed(),
			);
		}

		// Re-read: the wait is wall-clock time in which anything could have
		// moved the holder's balance, and a refusal against a drained
		// account would say "nothing to take" rather than anything about
		// the deadline.
		const fresh = await readBalance(ctx, owner.address);
		if (fresh.kind === "defect") {
			return failed(
				`${fresh.detail}; the premise cannot be established`,
				elapsed(),
				fresh.error === "" ? {} : { error: fresh.error },
			);
		}
		if (fresh.kind !== "value") {
			return unverifiable(
				`holder balance unreadable after the wait (${fresh.detail}); a refusal now would say nothing either way`,
				elapsed(),
			);
		}
		if (fresh.amount < SPEND_AMOUNT) {
			return unverifiable(
				"the holder spent elsewhere while waiting for the deadline; a refusal now would say the account drained rather than anything about expiry",
				elapsed(),
			);
		}

		// Same for the recipient: a trustline closed during the wait would
		// refuse for asset policy rather than the deadline. Issuer status
		// needs no re-check — addresses do not become issuers mid-run.
		const freshRecipient = await readBalance(ctx, spender.address);
		if (freshRecipient.kind === "defect") {
			return failed(
				`${freshRecipient.detail}; the premise cannot be established`,
				elapsed(),
				freshRecipient.error === "" ? {} : { error: freshRecipient.error },
			);
		}
		if (freshRecipient.kind !== "value") {
			return unverifiable(
				`recipient balance unreadable after the wait (${freshRecipient.detail}); a refusal now would say nothing either way`,
				elapsed(),
			);
		}

		// The grant should be dead. If the contract still reports an amount,
		// that is not yet a finding — `allowance()` is permitted to report a
		// stale amount, and the spend is what settles it.
		const standing = await readAllowance(ctx, owner.address, spender.address);
		// A defective allowance() is the contract's fault, and this check
		// runs last — so recording it as merely "unreadable" and spending
		// anyway is the one path where a defect reaches no verdict at all.
		// Worse, the spend that follows would likely be refused, and a
		// refusal here is the PASS: the contract would be credited with
		// honouring a deadline in the same run it returned an impossible
		// quantity.
		if (standing.kind === "defect") {
			return failed(
				`${standing.detail}; the grant cannot be read to say what the spend was tested against`,
				elapsed(),
				standing.error === "" ? {} : { error: standing.error },
			);
		}
		const reported =
			standing.kind === "value" ? `${standing.amount}` : "unreadable";

		const submitted = await submitWrite(
			ctx.server,
			{
				contractId: ctx.contractId,
				method: "transfer_from",
				args: [
					addressArg(spender.address),
					addressArg(owner.address),
					addressArg(spender.address),
					amountArg(SPEND_AMOUNT),
				],
				signer: spender.signer,
			},
			ctx.networkPassphrase,
		);

		const reading = readRefusal(submitted, WORDING);
		if (reading.kind === "inconclusive") {
			return inconclusiveResult(reading, expiredMeta, EXPECTED, elapsed());
		}
		if (reading.kind === "refused") {
			return {
				...expiredMeta,
				status: "PASS",
				expected: EXPECTED,
				actual: `a spend against an allowance that expired at ledger ${expiresAt} was refused at ledger ${reached}`,
				evidence: {
					// The post-wait reads, not the premise ones taken before
					// the approval: the wait is wall-clock time in which the
					// holder can spend elsewhere and still stay above
					// SPEND_AMOUNT, and evidence that reports a balance which
					// was not true at submission misdescribes the run.
					before: {
						// The grant as read back right after approving, then
						// the amount reported after the wait. Without the first,
						// "0" reads the same as a grant that never landed —
						// and it is the confirmed grant that makes this PASS
						// a statement about the deadline.
						granted: `${granted.amount}`,
						allowance: reported,
						holder: `${fresh.amount}`,
						recipient: `${freshRecipient.amount}`,
					},
					ledger: reached,
					error: reading.diagnostics,
				},
				durationMs: elapsed(),
			};
		}

		return failed(
			`a spend succeeded against an allowance that expired at ledger ${expiresAt}, submitted at ledger ${reached}; consistent with the contract storing the amount but not its deadline, which would leave every approval it has ever granted permanent`,
			elapsed(),
			{
				// Post-wait, for the same reason as the PASS above: a FAIL
				// accuses the contract of ignoring a deadline, and the
				// balances it cites have to be the ones that were true when
				// the spend was submitted.
				before: {
					granted: `${granted.amount}`,
					allowance: reported,
					holder: `${fresh.amount}`,
					recipient: `${freshRecipient.amount}`,
				},
				txHash: reading.txHash,
				ledger: reading.ledger,
			},
		);
	},
};
