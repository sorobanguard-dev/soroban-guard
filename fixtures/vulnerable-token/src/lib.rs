//! A deliberately non-conformant SEP-41 token.
//!
//! This exists for one reason: a conformance checker that has only ever run
//! against correct contracts has proved it does not cry wolf, and nothing
//! more. Every negative check in the guard is written to FAIL a contract
//! that lacks a guard — but a check that silently never fires looks exactly
//! like a check that fires correctly, as long as every contract under test
//! is correct. This token is the contract that deserves a red mark.
//!
//! NOT A TEMPLATE. Every omission below is deliberate and would lose funds
//! on a real network. It is published nowhere and deployed only to testnet.
//!
//! ## The flaws, one per check
//!
//! Each is targeted by exactly one of the guard's checks, so a FAIL
//! identifies which guard is missing rather than merely that something is
//! wrong. `transfer` is the vulnerable path; `transfer_from` keeps its
//! allowance accounting honest so the expiry check reads a real grant.
//!
//! Targeted, not necessarily reported: a contract with several arithmetic
//! holes cannot have all of them exercised in one run. The first flaw that
//! goes unrefused leaves an account below zero, and checks that read that
//! account afterwards report UNVERIFIABLE rather than testing their own
//! rule.
//!
//! So of the **four checks tabled below**, a run yields two failures and
//! two unverifiable rows rather than four failures. That is not the whole
//! report: a full sixteen-check run against this token reads
//! `9 pass, 2 fail, 5 unverifiable`, because checks outside this table read
//! the same damaged accounts. See the fixture README and
//! `docs/verification.md` for a logged run.
//!
//! | Flaw | Guard check that targets it |
//! |------|---------------------------|
//! | `transfer` never compares against the balance | `sep41-transfer-over-balance` |
//! | `transfer` never rejects a negative amount | `sep41-transfer-negative-amount` |
//! | `transfer` reads both balances before writing either | `sep41-transfer-self` |
//! | `transfer_from` ignores `live_until_ledger` | `sep41-transfer_from-expired` |
//!
//! The third was not designed — it was *found*, by running the guard against
//! this contract. `transfer` loads `from` and `to` into separate locals and
//! then writes both; when they are the same address the second write clobbers
//! the first, so a self-transfer nets the amount instead of zero — the
//! guard's +1 probe leaves the holder one unit richer. The
//! guard reported it as "debiting and crediting the same address must net
//! zero", which is a more precise description than the one this comment
//! originally claimed. Kept rather than fixed: an unintended defect that a
//! check catches is better evidence than a planted one.
//!
//! Zero-amount transfers stay *correct* here, and `sep41-transfer-zero-amount`
//! must still PASS — zero nets zero even through the aliasing bug above, which
//! is exactly why the two no-op checks are separate. That asymmetry is the
//! point: a run against this token must produce a mix, not a uniform wall of
//! red, or it proves only that the guard dislikes this contract rather than
//! that it located specific defects.

#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, String};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Balance(Address),
    /// (owner, spender) -> amount. The expiry ledger is deliberately not
    /// stored: that omission is the expired-allowance flaw.
    Allowance(Address, Address),
    Admin,
    Decimals,
    Name,
    Symbol,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
    InsufficientAllowance = 2,
    /// Rejected by the delegated paths only. `transfer` deliberately has no
    /// such check — that is the flaw `sep41-transfer-negative-amount`
    /// targets.
    NegativeAmount = 4,
}

#[contract]
pub struct VulnerableToken;

#[contractimpl]
impl VulnerableToken {
    /// Runs once, atomically with deployment.
    ///
    /// A separate `initialize` entry point would leave a window between
    /// deploy and setup in which anyone could claim `Admin` and mint at
    /// will. That is a real vulnerability but *not* one this fixture
    /// targets — no check looks for it, so it would only add noise to a
    /// run and hand a testnet contract to whoever front-ran the deploy.
    /// The flaws here are the four tabled above, and deployment is not
    /// where they live.
    pub fn __constructor(
        env: Env,
        admin: Address,
        decimals: u32,
        name: String,
        symbol: String,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
    }

    /// Admin-only faucet, so the guard's holder can be given a balance to
    /// spend. Authorization is enforced here — an open mint would make the
    /// token uninteresting for every other check.
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotAuthorized)?;
        admin.require_auth();
        let current = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to), &(current + amount));
        Ok(())
    }

    // --- Reads: correct, so the interface checks pass ------------------

    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap_or(7)
    }

    pub fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Name)
            .unwrap_or_else(|| String::from_str(&env, "Vulnerable"))
    }

    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "VULN"))
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Allowance(from, spender))
            .unwrap_or(0)
    }

    // --- Writes ---------------------------------------------------------

    /// FLAW 1 and 2: no balance floor, no sign check.
    ///
    /// A conformant `transfer` rejects an amount above the holder's balance
    /// and rejects a negative amount. This does neither. It authenticates
    /// the holder correctly — the hole is arithmetic, not authorization,
    /// which is what makes it the realistic shape: the signature checks out
    /// and the call still moves value that never existed.
    ///
    /// Over-balance: `from` goes negative and `to` is credited out of
    /// nothing, minting supply on every overdraft.
    ///
    /// Negative amount: the subtraction and addition invert, so the call
    /// reads as a transfer *from* `to` *to* `from` — a withdrawal anyone
    /// can perform against anyone, authorized by the wrong party.
    ///
    /// Self-transfer: both balances are read before either is written, so
    /// when `from == to` the second write overwrites the first and the net
    /// is `+amount` instead of zero. This one was not planted — the guard
    /// found it. A conformant implementation either special-cases the
    /// aliasing or re-reads between writes.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();

        let from_balance = Self::balance(env.clone(), from.clone());
        let to_balance = Self::balance(env.clone(), to.clone());

        // A conformant implementation needs both of these. Neither is here:
        //   if amount < 0 { panic!("negative amount") }
        //   if from_balance < amount { panic!("insufficient balance") }
        env.storage()
            .persistent()
            .set(&DataKey::Balance(from), &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to), &(to_balance + amount));
    }

    /// Correct: the allowance is recorded, and `live_until_ledger` is
    /// accepted from the caller and then thrown away. Storing the amount
    /// while dropping the deadline is the single most common real form of
    /// this bug — the grant looks right to `allowance()` and never dies.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        _live_until_ledger: u32,
    ) {
        from.require_auth();
        // FLAW 3 lives here: _live_until_ledger is discarded rather than
        // stored alongside the amount, so nothing can ever expire.
        env.storage()
            .persistent()
            .set(&DataKey::Allowance(from, spender), &amount);
    }

    /// Allowance accounting is honest — the spend is checked against the
    /// recorded amount and decremented. The only defect reachable here is
    /// the missing expiry, inherited from `approve`. That keeps
    /// `sep41-transfer_from-unauthorized` PASSing (a spender with no grant
    /// is refused) while `sep41-transfer_from-expired` FAILs.
    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        spender.require_auth();

        // Deliberately *not* a flaw. `allowance < amount` is false for any
        // negative amount, so without this a spender with no grant at all
        // passes the allowance check and debits `to`.
        //
        // The guard never sends a negative here — every `_from` path uses a
        // positive constant — so this hole was latent, not one the suite
        // could trip. It is closed anyway because the table above is a
        // promise about which flaws this contract has, and an untabled hole
        // breaks that promise for anyone reading the fixture or invoking it
        // directly. The vulnerable path here is the missing expiry inherited
        // from `approve`; `transfer` keeps its sign-blindness.
        if amount < 0 {
            return Err(Error::NegativeAmount);
        }

        let allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        if allowance < amount {
            return Err(Error::InsufficientAllowance);
        }

        env.storage().persistent().set(
            &DataKey::Allowance(from.clone(), spender),
            &(allowance - amount),
        );

        let from_balance = Self::balance(env.clone(), from.clone());
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(from), &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to), &(to_balance + amount));
        Ok(())
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        let from_balance = Self::balance(env.clone(), from.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(from), &(from_balance - amount));
    }

    pub fn burn_from(
        env: Env,
        spender: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), Error> {
        spender.require_auth();
        // Same reasoning as transfer_from: an untargeted hole here would
        // produce findings this fixture does not claim.
        if amount < 0 {
            return Err(Error::NegativeAmount);
        }
        let allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        if allowance < amount {
            return Err(Error::InsufficientAllowance);
        }
        env.storage().persistent().set(
            &DataKey::Allowance(from.clone(), spender),
            &(allowance - amount),
        );
        let from_balance = Self::balance(env.clone(), from.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(from), &(from_balance - amount));
        Ok(())
    }
}
