import type { Account, rpc } from "@stellar/stellar-sdk";
import type { Signer } from "@stellar/stellar-sdk/contract";

/**
 * One party in a check, and whether this run can act as them.
 *
 * `address` is always known — reads need nothing more, and asking a
 * contract for a balance requires no permission. `signer` is present only
 * when the run holds the secret key, which is what a state-changing call
 * needs. Absence is a fact about us, never about the contract: a write
 * check without a signer reports UNVERIFIABLE, the same way a probe with no
 * standing does.
 *
 * Optional by design, following the SDK's own `signTransaction?` and the
 * read/write client split every major chain library settled on: identity
 * and signing authority are separate things.
 */
export interface Party {
	/**
	 * Ed25519 (`G…`) only, for now. The SDK's `Signer.address` is a plain
	 * string precisely so smart accounts can sign as `C…`, and nothing here
	 * depends on the key type — but the CLI gates on Ed25519 because a write
	 * needs a funded source account, and the funding path (Friendbot) knows
	 * only `G…`. Widening this means branching that path, not relaxing a
	 * validator; until then the narrower rule is stated rather than implied.
	 */
	readonly address: string;
	readonly signer?: Signer;
	/**
	 * True when this address was generated for the run rather than supplied.
	 * A generated probe asserting balance 0 proves nothing — it passes on
	 * every token, including always-zero bugs — so checks report UNVERIFIABLE
	 * instead of a vacuous PASS. Lives on the party because it is a fact
	 * about that address, not about the run.
	 */
	readonly isThrowaway: boolean;
}

/**
 * Everything a SEP-41 check needs to run. This is the concrete `Ctx` that
 * `Check<Ctx>` is generic over — it lives in sep41/, never in core/.
 *
 * `source` supplies the sequence number for simulation only; simulation
 * spends nothing. `owner` is funded on demand but never given a trustline:
 * a supplied owner needs a pre-existing TEST trustline for balance reads,
 * while a generated probe without one reports UNVERIFIABLE, never FAIL.
 * `spender` is never funded — simulation argument only. Roles, not
 * identities — which account plays each role is decided by the caller.
 *
 * `specFunctions` is the contract's declared function list when determinable
 * (WASM tokens), fetched once per run. `null` means undeterminable (SAC has
 * no spec to read) — checks proceed to simulation as if everything exists,
 * and a trap is judged on its own terms.
 */
export interface Sep41Context {
	readonly server: rpc.Server;
	readonly contractId: string;
	readonly source: Account;
	readonly networkPassphrase: string;
	readonly specFunctions: readonly string[] | null;
	/**
	 * Allowances this run established itself, as `owner:spender` pairs (see
	 * `grantKey` in approve.ts). `allowance()` shows an amount but never its
	 * `live_until_ledger`, so a standing grant may have expired — but one
	 * this run created seconds ago cannot have. Refusal paths consult this
	 * to tell the two apart. Mutable by design: checks run sequentially
	 * sharing one context, and this is the run's memory. Required (never
	 * optional) so a missing registry fails typecheck instead of silently
	 * downgrading every refusal to UNVERIFIABLE.
	 */
	readonly establishedAllowances: Set<string>;
	/**
	 * What this run has learned about the contract's accounting, once it has
	 * stopped adding up.
	 *
	 * A negative quantity is a defect, and the check that first sees one
	 * reports it. The problem is what comes after: a contract that lets the
	 * holder overdraw leaves the balance below zero, and every later check
	 * reads that same defect while establishing its own premise. Without
	 * this, one missing bounds check reports as nine failures — eight of
	 * them the first one's wake, with the real finding buried among them.
	 *
	 * So the first observation is recorded here, and later reads consult it:
	 * the finding is stated once as a FAIL, and the checks that can no
	 * longer measure anything say why they cannot rather than repeating it.
	 * Mutable for the same reason `establishedAllowances` is — checks run
	 * sequentially sharing one context, and this is the run's memory.
	 *
	 * Deliberately one flag for one property rather than a graph of which
	 * check invalidates which. A negative balance is the case that occurs;
	 * a second property can be added when a second one actually appears.
	 */
	readonly soundness: {
		/**
		 * Set when a quantity first reads negative, to the operator-facing
		 * detail of that reading (e.g. `balance() returned -1, which is
		 * negative`). Undefined means nothing unsound has been observed.
		 */
		firstNegative?: string;
	};
	/**
	 * The two roles, and the single home for their addresses. Reads take
	 * `parties.owner.address`; writes additionally need `parties.owner.signer`
	 * and report UNVERIFIABLE without it.
	 */
	readonly parties: {
		readonly owner: Party;
		readonly spender: Party;
	};
}
