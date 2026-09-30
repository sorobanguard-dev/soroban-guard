/**
 * The public demo token: `fixtures/vulnerable-token` built with the
 * `demo-faucet` feature, deployed to testnet on 2026-09-30.
 *
 * It exists so a visitor with only a wallet can run all sixteen checks. The
 * recorded fixture's mint is admin-only, so nobody else holds a balance and
 * every write reports UNVERIFIABLE. This deployment adds `faucet`, which
 * gives five units to anyone — exactly what a full run spends — and keeps
 * the four tabled flaws, so a run against it finds the same defects.
 *
 * Testnet is reset from time to time. After a reset, redeploy with the
 * fixture README's commands plus `--features demo-faucet`, and update this.
 */
export const DEMO_CONTRACT =
	"CBDMISFO47JSINAYSIPLDLJ6RZMP2L3MVLQPBSJ6YQO64V4XERIZZR54";

/** What one `faucet` call gives. Five is what a full run spends. */
export const DEMO_FAUCET_UNITS = 5;

export function isDemoContract(contractId: string): boolean {
	return contractId.trim() === DEMO_CONTRACT;
}
