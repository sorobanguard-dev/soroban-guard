/**
 * A real run, transcribed from `docs/verification.md`.
 *
 * Not illustrative numbers. This is the logged run of 2026-09-27 against
 * `fixtures/vulnerable-token` as deployed on testnet, row for row, with
 * `actual` quoting what the report printed. A site for a conformance tool
 * should not put invented verdicts on its front page — and the tally the
 * page displays is counted from this array, so it cannot drift from it
 * either.
 *
 * `expected` is the clause the check asserts, and `need` is what the run
 * would require to turn an UNVERIFIABLE into a verdict. Both come from the
 * check implementations in `packages/soroban-guard/src/sep41/checks/`.
 */
import type { CheckStatus } from "soroban-guard/src/core/types.ts";

export interface RecordedRow {
	readonly status: CheckStatus;
	readonly id: string;
	readonly actual: string;
	readonly expected: string;
	readonly need?: string;
	readonly txHash?: string;
}

/** The contract the run was made against. */
export const RECORDED_CONTRACT =
	"CDYOSYSK6C334LXIZULHLKOYRKF4HBQHLK7EIH5VEHQDCTJIBPZOHGXY";

/** 9 pass, 2 fail, 5 unverifiable — the run exits 1. */
export const RECORDED_EXIT = 1;

export const RECORDED_RUN: readonly RecordedRow[] = [
	{
		status: "PASS",
		id: "sep41-decimals",
		actual: "returned 7",
		expected: "decimals() returns a non-negative integer",
	},
	{
		status: "PASS",
		id: "sep41-balance",
		actual: "balance is 1000",
		expected: "balance() returns a non-negative integer for any address",
	},
	{
		status: "PASS",
		id: "sep41-allowance",
		actual: "allowance is 0",
		expected: "allowance() returns a non-negative integer",
	},
	{
		status: "PASS",
		id: "sep41-name",
		actual: 'name is "Vulnerable Test Token"',
		expected: "name() returns a non-empty string",
	},
	{
		status: "PASS",
		id: "sep41-symbol",
		actual: 'symbol is "VULN"',
		expected: "symbol() returns a non-empty string",
	},
	{
		status: "PASS",
		id: "sep41-transfer_from-unauthorized",
		actual: "an unauthorized spend was refused",
		expected: "a spend with no allowance must be refused",
	},
	{
		status: "PASS",
		id: "sep41-transfer-zero-amount",
		actual: "the call was accepted and both balances held, at 1000 and 0",
		expected: "a zero transfer must not change either balance",
		txHash: "4a6129a464ff08db5eb2d83f6861508b6f0798ea86885f52a3a42882f191c8aa",
	},
	{
		status: "FAIL",
		id: "sep41-transfer-self",
		actual: "the holder's balance moved from 1000 to 1001",
		expected:
			"debiting and crediting the same address must net zero, so a change means one side was applied without the other",
		txHash: "2969d5ffd800aa79a577b8e03b2c57d15026ec418c9fb1b629a2d059c04fa7dc",
	},
	{
		status: "FAIL",
		id: "sep41-transfer-negative-amount",
		actual:
			"a transfer of -1 succeeded; the holder gained, consistent with the contract reading it as a transfer in the opposite direction — anyone can withdraw from anyone",
		expected: "a negative amount must be refused",
	},
	{
		status: "UNVERIFIABLE",
		id: "sep41-transfer-over-balance",
		actual:
			"recipient balance unreadable — balance() returned -1, and this contract's accounting already went negative earlier in the run",
		expected: "more than the balance must be refused",
		need: "a contract whose accounting has not already gone negative",
	},
	{
		status: "UNVERIFIABLE",
		id: "sep41-transfer",
		actual: "balances unreadable",
		expected: "transfer() moves exactly the amount between the two parties",
		need: "a readable before-state to compare against",
		txHash: "17dcefa66339200ba744be506b9726d8c32a462a057db668d1d764f1d5a1a551",
	},
	{
		status: "PASS",
		id: "sep41-approve",
		actual: "allowance is 2 after approving 2 over 1",
		expected: "approve() sets the allowance it was given",
		txHash: "9517b3f5e8ba9e502c1c7c1e8b909ee9f387b1fa8f5f181758b7c910d9ef5ca2",
	},
	{
		status: "UNVERIFIABLE",
		id: "sep41-transfer_from",
		actual:
			"balance() returned -1; this contract's accounting already went negative earlier in the run, so nothing measured against it can be trusted",
		expected: "transfer_from() spends against the allowance",
		need: "a readable before-state to compare against",
		txHash: "15f5690fb74ddea06d94c1ac0d7920dd0dc310729af7b3e1cec79a3b0a68a679",
	},
	{
		status: "PASS",
		id: "sep41-burn",
		actual: "holder -1",
		expected: "burn() reduces the holder's balance by the amount",
		txHash: "bebdd4730b024264180f37f4e37629178e8af0a54a7481c1406d4b7a6cff28ea",
	},
	{
		status: "UNVERIFIABLE",
		id: "sep41-burn_from",
		actual: "spender balance unreadable",
		expected:
			"burn_from() reduces the holder's balance and leaves the spender's untouched",
		need: "a readable spender balance",
		txHash: "559dea4f68b9c02a249ca4bf8ad5dc364d5669939d4e59209db8c1cbf11ddb57",
	},
	{
		status: "UNVERIFIABLE",
		id: "sep41-transfer_from-expired",
		actual:
			"recipient balance unreadable — balance() returned -1, and this contract's accounting already went negative earlier in the run",
		expected: "a lapsed allowance must be refused",
		need: "a contract whose accounting has not already gone negative",
	},
];
