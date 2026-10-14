// Strict receipt assessment. A transaction that merely reached a decided state
// is NOT a successful one: UNDETERMINED, disagreement and reverts must surface
// as explicit errors. A write counts as successful only if ALL of these hold:
//   lifecycle  ACCEPTED or FINALIZED
//   consensus  MAJORITY_AGREE
//   execution  FINISHED_WITH_RETURN
//
// Studio Next returns lifecycle names snake_cased (`status_name`,
// `result_name`) while the SDK typings spell them camelCase; both are read and
// neither is assumed.

export type ReceiptFailure =
  | "UNDETERMINED"
  | "MAJORITY_DISAGREE"
  | "NO_MAJORITY"
  | "TIMEOUT"
  | "REVERTED"
  | "NOT_FINAL"
  | "MALFORMED";

export type ReceiptAssessment =
  | { ok: true; status: string; consensus: string; execution: string }
  | { ok: false; failure: ReceiptFailure; message: string };

type Loose = Record<string, unknown>;

const pick = (r: Loose, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
};

// Numeric protocol codes (the same table genlayer-js ships).
const STATUS_BY_CODE: Record<number, string> = {
  0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING",
  5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED",
};
// Consensus result codes are deliberately NOT mapped: Studio Next reported
// `result: 1` alongside `result_name: "MAJORITY_AGREE"`, which does not match the
// SDK's enum ordering. The name is authoritative; a receipt with only a numeric
// result is treated as malformed rather than guessed at.

export function assessReceipt(receipt: unknown): ReceiptAssessment {
  if (receipt === null || typeof receipt !== "object") {
    return { ok: false, failure: "MALFORMED", message: "The network returned no receipt for this transaction." };
  }
  const r = receipt as Loose;

  let status = pick(r, "statusName", "status_name");
  if (status === undefined && typeof r.status === "number") status = STATUS_BY_CODE[r.status];
  if (status === undefined && typeof r.status === "string" && !/^\d+$/.test(r.status)) status = r.status;

  const consensus = pick(r, "resultName", "result_name");

  const execution = pick(r, "txExecutionResultName", "tx_execution_result_name");

  if (status === "UNDETERMINED") {
    return {
      ok: false,
      failure: "UNDETERMINED",
      message: "Validators could not reach a determination. Nothing changed on-chain; you can retry.",
    };
  }
  if (consensus === "MAJORITY_DISAGREE" || consensus === "DISAGREE") {
    return {
      ok: false,
      failure: "MAJORITY_DISAGREE",
      message: "A majority of validators disagreed with the leader. The call did not take effect.",
    };
  }
  if (consensus === "NO_MAJORITY") {
    return { ok: false, failure: "NO_MAJORITY", message: "Validators did not form a majority. The call did not take effect." };
  }
  if (consensus === "TIMEOUT" || consensus === "MAJORITY_TIMEOUT") {
    return { ok: false, failure: "TIMEOUT", message: "Validators timed out. The call did not take effect." };
  }
  if (status !== "ACCEPTED" && status !== "FINALIZED") {
    return {
      ok: false,
      failure: "NOT_FINAL",
      message: `Transaction is ${status ?? "in an unknown state"}, not ACCEPTED or FINALIZED.`,
    };
  }
  if (consensus !== "MAJORITY_AGREE") {
    return {
      ok: false,
      failure: "MALFORMED",
      message: `Consensus result is ${consensus ?? "missing"}, expected MAJORITY_AGREE.`,
    };
  }
  if (execution !== "FINISHED_WITH_RETURN") {
    return {
      ok: false,
      failure: "REVERTED",
      message:
        execution === "FINISHED_WITH_ERROR"
          ? "The contract rejected this call (it reverted). No funds moved."
          : `Execution result is ${execution ?? "missing"}, expected FINISHED_WITH_RETURN.`,
    };
  }
  return { ok: true, status, consensus, execution };
}

export class ReceiptRejected extends Error {
  readonly failure: ReceiptFailure;
  readonly txHash?: string;
  constructor(failure: ReceiptFailure, message: string, txHash?: string) {
    super(message);
    this.name = "ReceiptRejected";
    this.failure = failure;
    this.txHash = txHash;
  }
}
