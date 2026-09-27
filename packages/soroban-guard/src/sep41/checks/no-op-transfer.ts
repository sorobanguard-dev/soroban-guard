/**
 * Two transfers that must not move value: zero units, and a transfer to
 * yourself.
 *
 * Unlike the other negative checks, **neither is required to be refused.**
 * SEP-41 says nothing about a zero amount and nothing about a self-transfer,
 * so a contract may accept either as a no-op and remain conformant, or
 * reject either and remain conformant. Asserting "must reject" here would
 * invent a requirement the specification does not state and FAIL correct
 * tokens — the failure mode this suite exists to avoid.
 *
 * What *is* required is arithmetic. Whichever way the contract answers, the
 * balances must be where they started:
 *
 *   zero-amount   — moving nothing changes nothing on either side.
 *   self-transfer — debiting and crediting the same address nets zero.
 *
 * So these assert an absence of change rather than an outcome, and the FAIL
 * is a balance that moved. A contract that mints on a zero transfer, or one
 * that debits without crediting when both addresses match, is broken in a
 * way no positive check sees: `transfer` with distinct parties and a real
 * amount behaves identically either way.
 *
 * A second FAIL, less obvious: a *defective* balance read after the call.
 * A `balance()` that traps or answers with something impossible — a
 * negative quantity, a non-`i128` — is the contract misbehaving, not an
 * answer this run failed to obtain, and `balanceCheck` FAILs the identical
 * response. Reporting UNVERIFIABLE here would give one contract two answers
 * in a run, and worse: `readQuantity` records a negative reading as the
 * run's first, so every later check would defer to a finding nobody stated
 * and the process would exit 2 for a contract that minted. A merely
 * *unreadable* balance — no answer, an archived entry — stays UNVERIFIABLE,
 * because that is a fact about the run rather than about the contract.
 *
 * Both share this module because they share their whole shape — same
 * assertion, same premises, same reading of the outcome. Only the amount
 * and the recipient differ.
 */
import { addressArg, amountArg, submitWrite } from "../../core/invoke.ts";
import type { CheckResult } from "../../core/types.ts";
import type { Sep41Context } from "../context.ts";
import { type QuantityRead, readBalance } from "./quantity.ts";
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
	verdictHelpers,
} from "./shared.ts";

/**
 * What distinguishes the two checks: the amount, and who receives it.
 *
 * `recipient` is a function of the parties rather than an address, because
 * the self-transfer case names the holder on both sides — which is the
 * whole point of it — while the zero case needs a genuinely separate one.
 */
interface NoOpVariant {
	readonly meta: CheckMeta;
	readonly description: string;
	readonly expected: string;
	readonly wording: RefusalWording;
	readonly amount: bigint;
	readonly recipient: (parties: Sep41Context["parties"]) => string;
	/** Why this particular call should leave the balance alone. */
	readonly rationale: string;
	/** Extra premise guards on the parties, run after the shared ones. */
	readonly guard?: (parties: Sep41Context["parties"]) => string | null;
	/**
	 * The smallest balance this variant needs before its answer means
	 * anything. A self-transfer of one unit against an empty holder could be
	 * refused for having nothing rather than for any rule about self-sends.
	 */
	readonly minimumBalance: bigint;
	/**
	 * Whether the recipient is a second address worth observing.
	 *
	 * False for the self case, where the recipient *is* the holder — one
	 * read already covers both sides, and a second would spend a round trip
	 * to learn the same number. True for the zero case, where a contract
	 * could hold the holder steady while crediting the recipient out of
	 * nothing, and watching only the sender would call that conformant.
	 */
	readonly watchRecipient: boolean;
}

function buildNoOpCheck(variant: NoOpVariant) {
	const { unverifiable, failed } = verdictHelpers(
		variant.meta,
		variant.expected,
	);
	return {
		...variant.meta,
		description: variant.description,
		async run(ctx: Sep41Context): Promise<CheckResult> {
			const started = Date.now();
			const elapsed = () => Date.now() - started;
			if (!isDeclared(ctx, "transfer")) {
				return notImplemented(variant.meta, "transfer", elapsed());
			}

			const { owner } = ctx.parties;
			if (owner.signer === undefined) {
				return unverifiable(
					"no signing authority for the holder; set OWNER_SECRET to attempt a transfer that must not move value",
					elapsed(),
				);
			}
			if (owner.signer.address !== owner.address) {
				return unverifiable(
					"the signer does not sign as the holder; supply a key for the address under test",
					elapsed(),
				);
			}
			const problem = variant.guard?.(ctx.parties) ?? null;
			if (problem !== null) {
				return unverifiable(problem, elapsed());
			}

			const before = await readBalance(ctx, owner.address);
			// A defective balance() is the contract's fault whichever check
			// reads it; balanceCheck FAILs the identical response.
			if (before.kind === "defect") {
				return failed(
					`${before.detail}; the premise cannot be established`,
					elapsed(),
					before.error === "" ? {} : { error: before.error },
				);
			}
			if (before.kind !== "value") {
				return unverifiable(
					"holder balance unreadable; cannot establish that it did not change",
					elapsed(),
				);
			}
			// An issuer's balance is a sentinel, not a holding: it reads
			// i64::MAX before and after whatever happens, so "unchanged"
			// would be true of a contract that moved real value.
			if (before.amount === ISSUER_SENTINEL_BALANCE) {
				return unverifiable(
					"the holder is the asset issuer (balance reads i64::MAX); the sentinel does not move, so an unchanged balance would prove nothing",
					elapsed(),
				);
			}
			if (before.amount < variant.minimumBalance) {
				return unverifiable(
					`the holder has ${before.amount}; a refusal would say the account is empty rather than anything about this call`,
					elapsed(),
				);
			}

			// The far side, when it is a different address. Without it the
			// promise this check makes — that *both* balances hold — is only
			// half observed, and a contract crediting the recipient out of
			// nothing would pass on an unmoved sender.
			let recipientBefore: bigint | null = null;
			if (variant.watchRecipient) {
				const read = await readBalance(ctx, variant.recipient(ctx.parties));
				if (read.kind === "defect") {
					return failed(
						`${read.detail}; the premise cannot be established`,
						elapsed(),
						read.error === "" ? {} : { error: read.error },
					);
				}
				if (read.kind !== "value") {
					return unverifiable(
						`recipient balance unreadable (${read.detail}); cannot establish that it did not change`,
						elapsed(),
					);
				}
				if (read.amount === ISSUER_SENTINEL_BALANCE) {
					return unverifiable(
						"the recipient is the asset issuer (balance reads i64::MAX); the sentinel does not move, so an unchanged balance would prove nothing",
						elapsed(),
					);
				}
				recipientBefore = read.amount;
			}

			const submitted = await submitWrite(
				ctx.server,
				{
					contractId: ctx.contractId,
					method: "transfer",
					args: [
						addressArg(owner.address),
						addressArg(variant.recipient(ctx.parties)),
						amountArg(variant.amount),
					],
					signer: owner.signer,
				},
				ctx.networkPassphrase,
			);

			const reading = readRefusal(submitted, variant.wording);
			if (reading.kind === "inconclusive") {
				return inconclusiveResult(
					reading,
					variant.meta,
					variant.expected,
					elapsed(),
				);
			}
			// Refusing is conformant here, not the PASS condition — the
			// specification permits it and permits accepting. Reported as its
			// own sentence so a reader knows which the contract chose.
			if (reading.kind === "refused") {
				return {
					...variant.meta,
					status: "PASS",
					expected: variant.expected,
					actual: `the call was refused, which moves nothing; SEP-41 permits refusing as readily as accepting it`,
					// Both premises, same as the accepted path. The recipient was
					// read to prove it is not the issuer, so a reader checking
					// this PASS should see what it was checked against —
					// reporting half the premise on one branch and all of it on
					// the other makes the two look like different checks.
					evidence: {
						before: {
							holder: `${before.amount}`,
							...(recipientBefore === null
								? {}
								: { recipient: `${recipientBefore}` }),
						},
						error: reading.diagnostics,
					},
					durationMs: elapsed(),
				};
			}

			// It was accepted. Now the arithmetic has to hold.
			//
			// Guarded for the same reason the FAIL paths elsewhere are: the
			// call landed, so its hash is evidence a reader needs whatever
			// the read does next. Unlike those, the verdict here stays
			// UNVERIFIABLE — an unread balance leaves it genuinely unknown
			// whether anything moved, and a throw is no more evidence of a
			// violation than a trustline error is.
			let after: QuantityRead;
			try {
				after = await readBalance(ctx, owner.address);
			} catch (error) {
				return {
					...variant.meta,
					status: "UNVERIFIABLE",
					expected: variant.expected,
					actual:
						"the call was accepted but the resulting balance could not be read, so it is unknown whether anything moved",
					evidence: {
						before: {
							holder: `${before.amount}`,
							...(recipientBefore === null
								? {}
								: { recipient: `${recipientBefore}` }),
						},
						txHash: reading.txHash,
						ledger: reading.ledger,
						error: error instanceof Error ? error.message : String(error),
					},
					durationMs: elapsed(),
				};
			}
			// A defective after-read is the contract's fault, not a missing
			// answer — balanceCheck FAILs the identical response, and the
			// premise reads above already FAIL it. Collapsing it into
			// UNVERIFIABLE with the no-answer case would be the one place a
			// defect goes unreported: `readQuantity` still records it as the
			// run's first negative, so the flag is set and every later check
			// defers to a finding that was never stated. `zero-amount` admits
			// an empty holder (minimumBalance 0n), so a contract that debits
			// on a zero transfer reaches exactly here.
			if (after.kind === "defect") {
				return failed(`the call was accepted and ${after.detail}`, elapsed(), {
					before: {
						holder: `${before.amount}`,
						...(recipientBefore === null
							? {}
							: { recipient: `${recipientBefore}` }),
					},
					txHash: reading.txHash,
					ledger: reading.ledger,
					...(after.error === "" ? {} : { error: after.error }),
				});
			}
			if (after.kind !== "value") {
				// Through the helper's object form, not its string form: the
				// evidence here is the hash of a call that did land, and the
				// string overload would put a transaction id in the error
				// slot where a diagnostic belongs.
				return unverifiable(
					`the call was accepted but ${after.detail}, so it is unknown whether anything moved`,
					elapsed(),
					{
						before: {
							holder: `${before.amount}`,
							...(recipientBefore === null
								? {}
								: { recipient: `${recipientBefore}` }),
						},
						txHash: reading.txHash,
						ledger: reading.ledger,
					},
				);
			}
			// The recipient's side, read only when it is a second address.
			// An unreadable one here is not a verdict: the call landed, and
			// half an observation cannot say whether value appeared.
			let recipientAfter: bigint | null = null;
			if (recipientBefore !== null) {
				// Guarded like the holder read above: the call landed, so a
				// transport throw here must not reach the runner as SKIPPED and
				// take the hash down with it.
				let read: QuantityRead;
				try {
					read = await readBalance(ctx, variant.recipient(ctx.parties));
				} catch (error) {
					return {
						...variant.meta,
						status: "UNVERIFIABLE",
						expected: variant.expected,
						actual: `the call was accepted and the holder held at ${before.amount}, but the recipient's balance could not be read, so it is unknown whether value appeared there`,
						evidence: {
							before: {
								holder: `${before.amount}`,
								recipient: `${recipientBefore}`,
							},
							// The recipient is named unreadable rather than left
							// out: `before` reports it, so an absent key here
							// reads as an account that vanished instead of one
							// this run could not see.
							after: {
								holder: `${after.amount}`,
								recipient: "unreadable",
							},
							txHash: reading.txHash,
							ledger: reading.ledger,
							error: error instanceof Error ? error.message : String(error),
						},
						durationMs: elapsed(),
					};
				}
				// The recipient's side of the rule the holder's after-read
				// already follows: a defective read is the contract's doing,
				// so it FAILs rather than reporting no answer. A zero
				// transfer that credits the recipient into negative territory
				// reaches exactly here, and `readQuantity` has already
				// recorded it as the run's first negative — so reporting
				// UNVERIFIABLE would set the flag, suppress every later
				// check, and exit 2 for a contract that minted.
				if (read.kind === "defect") {
					return failed(
						// Says what the holder actually did rather than
						// assuming it held: this branch never compared them,
						// and a moved holder is its own finding.
						after.amount === before.amount
							? `the call was accepted and the holder held at ${before.amount}, but ${read.detail}`
							: `the call was accepted, the holder's balance moved from ${before.amount} to ${after.amount}, and ${read.detail}`,
						elapsed(),
						{
							before: {
								holder: `${before.amount}`,
								recipient: `${recipientBefore}`,
							},
							after: {
								holder: `${after.amount}`,
								recipient: "unreadable (defective read)",
							},
							txHash: reading.txHash,
							ledger: reading.ledger,
							...(read.error === "" ? {} : { error: read.error }),
						},
					);
				}
				// The holder's side is already decided, so an unreadable
				// recipient must not take the finding down with it: a holder
				// that moved is a FAIL whatever the far side says, and the
				// old message even asserted it "held" without checking.
				// Only when the holder genuinely held does the recipient's
				// readability decide the verdict.
				if (read.kind !== "value" && after.amount !== before.amount) {
					return failed(
						`the holder's balance moved from ${before.amount} to ${after.amount}; ${variant.rationale} (the recipient's balance could not be read, but the holder's move is the finding)`,
						elapsed(),
						{
							before: {
								holder: `${before.amount}`,
								recipient: `${recipientBefore}`,
							},
							after: {
								holder: `${after.amount}`,
								recipient: "unreadable",
							},
							txHash: reading.txHash,
							ledger: reading.ledger,
						},
					);
				}
				if (read.kind !== "value") {
					return {
						...variant.meta,
						status: "UNVERIFIABLE",
						expected: variant.expected,
						actual: `the call was accepted and the holder held at ${before.amount}, but the recipient's balance could not be read, so it is unknown whether value appeared there`,
						evidence: {
							before: {
								holder: `${before.amount}`,
								recipient: `${recipientBefore}`,
							},
							// Named unreadable rather than omitted, for the same
							// reason as the throw above.
							after: {
								holder: `${after.amount}`,
								recipient: "unreadable",
							},
							txHash: reading.txHash,
							ledger: reading.ledger,
						},
						durationMs: elapsed(),
					};
				}
				recipientAfter = read.amount;
			}

			const evidence = {
				before: {
					holder: `${before.amount}`,
					...(recipientBefore === null
						? {}
						: { recipient: `${recipientBefore}` }),
				},
				after: {
					holder: `${after.amount}`,
					...(recipientAfter === null
						? {}
						: { recipient: `${recipientAfter}` }),
				},
				txHash: reading.txHash,
				ledger: reading.ledger,
			};
			if (after.amount !== before.amount) {
				return failed(
					`the holder's balance moved from ${before.amount} to ${after.amount}; ${variant.rationale}`,
					elapsed(),
					evidence,
				);
			}
			// A contract can hold the sender steady and credit the far side
			// out of nothing. Watching only the sender would call that
			// conformant, which is the whole reason the recipient is read.
			if (recipientBefore !== null && recipientAfter !== recipientBefore) {
				return failed(
					`the holder held at ${before.amount} but the recipient moved from ${recipientBefore} to ${recipientAfter}; value appeared without leaving anywhere`,
					elapsed(),
					evidence,
				);
			}
			return {
				...variant.meta,
				status: "PASS",
				expected: variant.expected,
				actual:
					recipientBefore === null
						? `the call was accepted and the balance held at ${before.amount}`
						: `the call was accepted and both balances held, at ${before.amount} and ${recipientBefore}`,
				evidence,
				durationMs: elapsed(),
			};
		},
	};
}

export const zeroAmountTransferCheck = buildNoOpCheck({
	meta: {
		id: "sep41-transfer-zero-amount",
		clause: "SEP-41 §transfer",
		layer: "behavior",
		requirement: "required",
	} as const satisfies CheckMeta,
	description:
		"transfer() of zero moves nothing, whether it is accepted or refused",
	expected: "a transfer of zero leaves both balances unchanged",
	wording: {
		attempt: "the zero-amount transfer",
		rule: "a zero transfer leaves balances alone",
	},
	amount: 0n,
	recipient: (parties) => parties.spender.address,
	rationale: "a transfer of zero must move nothing",
	// Zero moves nothing even against an empty holder, so no minimum.
	minimumBalance: 0n,
	watchRecipient: true,
	guard: (parties) => {
		if (parties.owner.address === parties.spender.address) {
			return "holder and recipient are the same address; that is the self-transfer case, not this one — set SPENDER_ADDRESS to a different account";
		}
		// A contract wrong enough to credit on a zero transfer is not wrong
		// in a way bounded by the amount — the over-balance class shows a
		// broken contract can move more than asked. If it moved real value
		// to a key this process discards at exit, that value is gone.
		if (parties.spender.isThrowaway) {
			return "the recipient was generated for this run and its key is discarded at exit; a contract that moved value on a zero transfer would send it somewhere unrecoverable — set SPENDER_ADDRESS to an account you control";
		}
		return null;
	},
});

export const selfTransferCheck = buildNoOpCheck({
	meta: {
		id: "sep41-transfer-self",
		clause: "SEP-41 §transfer",
		layer: "behavior",
		requirement: "required",
	} as const satisfies CheckMeta,
	description:
		"transfer() to yourself nets zero, whether it is accepted or refused",
	expected: "a transfer to oneself leaves the balance unchanged",
	wording: {
		attempt: "the self-transfer",
		rule: "a self-transfer nets zero",
	},
	// One unit, so a contract that debits without crediting loses exactly
	// one and the delta is unambiguous.
	amount: 1n,
	recipient: (parties) => parties.owner.address,
	rationale:
		"debiting and crediting the same address must net zero, so a change means one side was applied without the other",
	// One unit must actually be there, or a refusal says "empty account"
	// rather than anything about self-transfers. The holder is both sides,
	// so a throwaway spender is irrelevant and gets no guard.
	minimumBalance: 1n,
	// The recipient is the holder, so one read covers both sides.
	watchRecipient: false,
});
