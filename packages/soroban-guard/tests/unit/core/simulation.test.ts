import {
	Account,
	Address,
	Networks,
	Operation,
	type rpc,
	TransactionBuilder,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
	classifySimulationFailure,
	describeSimulationFailure,
} from "../../../src/core/simulation.ts";
import { classifyStanding } from "../../../src/sep41/checks/shared.ts";
import {
	asAnswerTo,
	contractRefusal,
	hostError,
	setTrap,
	type TrapWire,
	testTrustlineMissing,
	withFields,
} from "../fixtures.ts";

/**
 * Only the invoked contract's own code refusing is evidence about it.
 * Every case starts from a real failure as testnet returned it (SET's
 * `transfer(-1)` trap, TEST's missing-trustline refusal) and changes one
 * thing, so a case that is not credited fails for the reason it names and
 * not for a malformed fixture.
 */
function failure(error: string): rpc.Api.SimulateTransactionErrorResponse {
	return setTrap({ error, events: "none" });
}

describe("classifySimulationFailure, contract errors", () => {
	it("credits the asset contract's refusal, with the reason its event gave", () => {
		expect(classifySimulationFailure(testTrustlineMissing())).toEqual({
			byContract: true,
			error: "Error(Contract, #13)",
			reason: "trustline entry is missing for account",
		});
	});

	it.each([4, 13, 101])(
		"credits error #%i raised by the invoked contract",
		(code) => {
			expect(
				classifySimulationFailure(contractRefusal(code, "refused")),
			).toEqual({
				byContract: true,
				error: `Error(Contract, #${code})`,
				reason: "refused",
			});
		},
	);

	// A token that passes on what a contract it called refused did not
	// refuse; the events say which contract raised the error.
	it("does not credit an error a contract the token called raised", () => {
		expect(
			classifySimulationFailure(
				contractRefusal(4, "refused", { raisedBy: new Uint8Array(32).fill(7) }),
			),
		).toEqual({ byContract: false, error: "Error(Contract, #4)" });
	});

	// A called contract's #4 and then the token's own #4 is the trace of a
	// token passing the error on, and equally of one that recovered from
	// it and then refused for itself. The trace cannot tell them apart.
	it("does not credit an error a called contract raised first and the token passed on", () => {
		expect(
			classifySimulationFailure(
				contractRefusal(4, "refused", {
					raisedBy: new Uint8Array(32).fill(7),
					passedOn: true,
				}),
			),
		).toEqual({ byContract: false, error: "Error(Contract, #4)" });
	});

	// Nothing says who raised an error no event carries, so it is no one's
	// refusal: neither with no events at all, nor when the token called
	// another contract and no event names who raised it.
	it.each([
		["no events at all", () => failure(hostError("Error(Contract, #4)"))],
		[
			"a call into another contract and no error event",
			() =>
				contractRefusal(4, undefined, {
					calls: new Uint8Array(32).fill(7),
					unattributed: true,
				}),
		],
		[
			"only the call, with no error event",
			() => contractRefusal(4, undefined, { unattributed: true }),
		],
	])("does not credit a contract error with %s", (_case, sim) => {
		expect(classifySimulationFailure(sim())).toEqual({
			byContract: false,
			error: "Error(Contract, #4)",
		});
	});

	// Calling another contract is no reason to doubt the token's own error.
	it("credits the token's own error after it called another contract", () => {
		expect(
			classifySimulationFailure(
				contractRefusal(4, "refused", { calls: new Uint8Array(32).fill(7) }),
			),
		).toMatchObject({ byContract: true, reason: "refused" });
	});

	// The reason is the refusing event's message alone: a log saying the
	// same words is not the asset refusing.
	it("reads the reason from the refusing event, not from a log", () => {
		const refused = classifySimulationFailure(
			contractRefusal(4, undefined, {
				log: "trustline entry is missing for account",
			}),
		);
		expect(refused).toEqual({
			byContract: true,
			error: "Error(Contract, #4)",
			reason: undefined,
		});
		expect(classifyStanding(refused.byContract ? refused : {})).toBeNull();
	});
});

describe("classifySimulationFailure, VM errors", () => {
	it("credits the invoked method trapping, as SET's refusal did", () => {
		expect(classifySimulationFailure(setTrap())).toEqual({
			byContract: true,
			error: "Error(WasmVm, InvalidAction)",
			reason: "VM call trapped: UnreachableCodeReached",
		});
	});

	// The same primary error with no evidence the method ran: how a module
	// that failed to load or translate looks.
	it.each([
		["no events at all", "none"],
		["the call but no trap", "call"],
	] as const)("does not credit a VM error with %s", (_case, events) => {
		expect(classifySimulationFailure(setTrap({ events }))).toEqual({
			byContract: false,
			error: "Error(WasmVm, InvalidAction)",
		});
	});

	it.each([
		[
			"a trap in another contract",
			(wire: TrapWire) => {
				wire.event.contractId = new Uint8Array(32).fill(7);
			},
		],
		[
			"a trap in another method",
			(wire: TrapWire) => {
				wire.event.body.v0.data.vec[1].sym = "approve";
			},
		],
		[
			"a trap the VM raised for its own reasons",
			(wire: TrapWire) => {
				wire.event.body.v0.data.vec[0].str = "VM call trapped: StackOverflow";
			},
		],
		[
			"an error event of another kind",
			(wire: TrapWire) => {
				// ScErrorCode 5 is ExceededLimit.
				wire.event.body.v0.topics[1].error.code = 5;
			},
		],
		[
			"a trap reported in a contract event rather than a diagnostic one",
			(wire: TrapWire) => {
				wire.event.type = 1;
			},
		],
	])("does not credit %s", (_case, change) => {
		expect(classifySimulationFailure(setTrap({ change })).byContract).toBe(
			false,
		);
	});
});

// The method's own trap beside another contract's VM failure: which one
// stopped the call, the trace does not say.
it.each([
	["a trap", undefined],
	// A call can recover from a called contract's missing export
	// (MissingValue, code 3) and then trap itself.
	["a missing export", 3],
])(
	"does not credit a trap when another contract's VM failed too, with %s",
	(_case, code) => {
		expect(
			classifySimulationFailure(
				setTrap({
					alsoFailedIn: new Uint8Array(32).fill(7),
					...(code === undefined ? {} : { alsoFailedCode: code }),
				}),
			).byContract,
		).toBe(false);
	},
);

// The invoked call is named by a diagnostic `fn_call` event; another kind
// of event naming it is no evidence of what ran.
it("does not credit a trap when the call is not a diagnostic event", () => {
	expect(classifySimulationFailure(setTrap({ callType: 1 })).byContract).toBe(
		false,
	);
});

describe("classifySimulationFailure, other failures", () => {
	it.each([
		["the host ran out of budget", hostError("Error(Budget, ExceededLimit)")],
		["the host failed internally", hostError("Error(Context, InternalError)")],
		// A generic authorization error is not tied to the rule any check is
		// testing.
		["an authorization error", hostError("Error(Auth, InvalidAction)")],
		["a VM error other than a trap", hostError("Error(WasmVm, InvalidInput)")],
	])("does not credit a failure where %s", (_case, error) => {
		expect(classifySimulationFailure(failure(error)).byContract).toBe(false);
	});

	// Only the primary error is read. One further down belongs to an inner
	// call, or is no more than text in a log.
	it("ignores a contract error that appears only in the event log", () => {
		expect(
			classifySimulationFailure(
				failure(
					hostError("Error(Budget, ExceededLimit)", "Error(Contract, #4)"),
				),
			),
		).toEqual({ byContract: false, error: "Error(Budget, ExceededLimit)" });
		expect(
			classifySimulationFailure(
				failure("transaction is malformed\n\nHostError: Error(Contract, #4)"),
			),
		).toEqual({ byContract: false, error: undefined });
	});

	// The same, with the invoked contract's own #4 events in the trace: the
	// primary error still decides, whatever later evidence matches.
	it("ignores a later contract error even when its events are present", () => {
		expect(
			classifySimulationFailure({
				...contractRefusal(4, "refused"),
				error: hostError("Error(Budget, ExceededLimit)", "Error(Contract, #4)"),
			}),
		).toEqual({ byContract: false, error: "Error(Budget, ExceededLimit)" });
	});
});

/**
 * Today's RPC puts only the primary error in `error`; the rest is in the
 * events. Report evidence keeps the whole trace for a person to read.
 */
describe("describeSimulationFailure", () => {
	it("carries the whole trace, where the error alone says nothing", () => {
		const described = describeSimulationFailure(testTrustlineMissing());
		expect(testTrustlineMissing().error).not.toContain("trustline");
		expect(described).toMatch(/^HostError: Error\(Contract, #13\)\n/);
		expect(described).toContain(
			'topics:[error, Error(Contract, #13)], data:["trustline entry is missing for account", GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL]',
		);
		expect(described).toContain(
			"contract:CARQGEM3RDSWA2SRZDL6LDBOEQWQHS74BOL5V62QXIGMOBIMIX5YTYYN",
		);
	});

	it("names the trap and the method in a VM refusal", () => {
		expect(describeSimulationFailure(setTrap())).toContain(
			'topics:[error, Error(WasmVm, InvalidAction)], data:["VM call trapped: UnreachableCodeReached", transfer]',
		);
	});

	// An RPC can simulate without diagnostics. A refusal-shaped error then
	// cannot be attributed, and the evidence says what would attribute it.
	it.each([
		[
			"a trap",
			"HostError: Error(WasmVm, InvalidAction)",
			"Error(WasmVm, InvalidAction)",
		],
		[
			"a contract error",
			"HostError: Error(Contract, #4)",
			"Error(Contract, #4)",
		],
	])(
		"says why %s without events cannot be attributed",
		(_case, error, named) => {
			expect(describeSimulationFailure(failure(error))).toBe(
				`${error}\n\nThe RPC returned no diagnostic event naming the call, so whether the contract itself raised ${named} cannot be established. An RPC that returns simulation diagnostics (stellar-rpc with preflight-enable-debug) can attribute it.`,
			);
		},
	);

	it("is the bare error when there are no events and nothing to attribute", () => {
		expect(
			describeSimulationFailure(
				failure("HostError: Error(Budget, ExceededLimit)"),
			),
		).toBe("HostError: Error(Budget, ExceededLimit)");
	});

	it("adds nothing when the events name the call", () => {
		expect(describeSimulationFailure(setTrap())).not.toContain(
			"no diagnostic event",
		);
	});
});

// The stub servers answer each simulation with a refusal rebuilt for the
// call they were sent, so a check's evidence names its own call.
describe("contractRefusal, as the answer to a call", () => {
	const contract = Address.contract(new Uint8Array(32).fill(3)).toString();
	const tx = new TransactionBuilder(
		new Account(
			"GAFD36WZNOJ4NBHB25QL6XRU2OYNIQC3IEUAXPIQ7FVDYLJE5H5ZVQ5G",
			"1",
		),
		{ fee: "100", networkPassphrase: Networks.TESTNET },
	)
		.addOperation(
			Operation.invokeContractFunction({
				contract,
				function: "allowance",
				args: [],
			}),
		)
		.setTimeout(30)
		.build();

	it("names the contract and method of the call it answers", () => {
		const answer = asAnswerTo(
			tx,
			withFields(contractRefusal(4, "refused"), { latestLedger: 9 }),
		);
		expect(classifySimulationFailure(answer)).toMatchObject({
			byContract: true,
			reason: "refused",
		});
		const evidence = describeSimulationFailure(answer);
		expect(evidence).toContain(`contract:${contract}`);
		expect(evidence).toMatch(/fn_call[^\]]*allowance/);
		expect(evidence).not.toContain("balance");
		expect(answer.latestLedger).toBe(9);
	});

	it("still credits nothing another contract raised", () => {
		const answer = asAnswerTo(
			tx,
			contractRefusal(4, "refused", { raisedBy: new Uint8Array(32).fill(7) }),
		);
		expect(classifySimulationFailure(answer)).toMatchObject({
			byContract: false,
		});
	});
});
