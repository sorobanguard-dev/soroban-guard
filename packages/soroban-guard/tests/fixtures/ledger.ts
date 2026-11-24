import { hash, xdr } from "@stellar/stellar-sdk";

const zero = new Uint8Array(32);

export function ledgerResult(
	transactionHash: string,
	result: xdr.TransactionResultResult,
): xdr.TransactionResultPair {
	return new xdr.TransactionResultPair({
		transactionHash,
		result: new xdr.TransactionResult({
			feeCharged: 0n,
			result,
			ext: xdr.TransactionResultExt.v0(),
		}),
	});
}

export function ledgerWithResults(
	sequence: number,
	closeTime: number,
	results: xdr.TransactionResultPair[],
) {
	const header = new xdr.LedgerHeader({
		ledgerVersion: 25,
		previousLedgerHash: zero,
		scpValue: new xdr.StellarValue({
			txSetHash: zero,
			closeTime: BigInt(closeTime),
			upgrades: [],
			ext: xdr.StellarValueExt.stellarValueBasic(),
		}),
		txSetResultHash: hash(new xdr.TransactionResultSet({ results }).toXdr()),
		bucketListHash: zero,
		ledgerSeq: sequence,
		totalCoins: 0n,
		feePool: 0n,
		inflationSeq: 0,
		idPool: 0n,
		baseFee: 0,
		baseReserve: 0,
		maxTxSetSize: 0,
		skipList: [zero, zero, zero, zero],
		ext: xdr.LedgerHeaderExt.v0(),
	});
	const headerXdr = new xdr.LedgerHeaderHistoryEntry({
		hash: hash(header.toXdr()),
		header,
		ext: xdr.LedgerHeaderHistoryEntryExt.v0(),
	});
	return {
		sequence,
		ledgerCloseTime: String(closeTime),
		headerXdr,
		metadataXdr: {
			type: "v2" as const,
			v2: {
				ledgerHeader: headerXdr,
				txProcessing: results.map((result) => ({ result })),
			},
		},
	};
}
