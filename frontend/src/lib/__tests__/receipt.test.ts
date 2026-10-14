import { describe, expect, it } from "vitest";
import { assessReceipt } from "../receipt";

const good = { status: 7, status_name: "FINALIZED", result: 1, result_name: "MAJORITY_AGREE", txExecutionResultName: "FINISHED_WITH_RETURN" };

describe("assessReceipt", () => {
  it("accepts the exact Studio Next receipt shape (snake_case names)", () => {
    expect(assessReceipt(good)).toMatchObject({ ok: true, status: "FINALIZED", consensus: "MAJORITY_AGREE" });
  });
  it("accepts camelCase names and ACCEPTED", () => {
    const r = assessReceipt({ statusName: "ACCEPTED", resultName: "MAJORITY_AGREE", txExecutionResultName: "FINISHED_WITH_RETURN" });
    expect(r.ok).toBe(true);
  });
  it("derives the lifecycle name from the numeric status when no name is sent", () => {
    expect(assessReceipt({ status: 5, resultName: "MAJORITY_AGREE", txExecutionResultName: "FINISHED_WITH_RETURN" }).ok).toBe(true);
  });
  it("treats UNDETERMINED as an explicit error", () => {
    const r = assessReceipt({ ...good, status_name: "UNDETERMINED", status: 6 });
    expect(r).toMatchObject({ ok: false, failure: "UNDETERMINED" });
  });
  it("treats MAJORITY_DISAGREE as an explicit error", () => {
    const r = assessReceipt({ ...good, result_name: "MAJORITY_DISAGREE" });
    expect(r).toMatchObject({ ok: false, failure: "MAJORITY_DISAGREE" });
  });
  it("rejects a decided-but-reverted execution", () => {
    const r = assessReceipt({ ...good, txExecutionResultName: "FINISHED_WITH_ERROR" });
    expect(r).toMatchObject({ ok: false, failure: "REVERTED" });
  });
  it("rejects non-final lifecycle states", () => {
    for (const s of ["PENDING", "PROPOSING", "COMMITTING", "REVEALING", "CANCELED"]) {
      expect(assessReceipt({ ...good, status_name: s, status: undefined }).ok).toBe(false);
    }
  });
  it("rejects every consensus result other than MAJORITY_AGREE", () => {
    for (const c of ["AGREE", "NO_MAJORITY", "TIMEOUT", "MAJORITY_TIMEOUT", "IDLE", "DETERMINISTIC_VIOLATION"]) {
      expect(assessReceipt({ ...good, result_name: c }).ok).toBe(false);
    }
  });
  it("does not trust a numeric consensus result without its name", () => {
    const { result_name: _omit, ...noName } = good;
    expect(assessReceipt(noName).ok).toBe(false);
  });
  it("rejects a missing execution result", () => {
    const { txExecutionResultName: _omit, ...none } = good;
    expect(assessReceipt(none)).toMatchObject({ ok: false, failure: "REVERTED" });
  });
  it.each([null, undefined, "tx", 42, []])("rejects non-object receipts %j", (v) => {
    expect(assessReceipt(v).ok).toBe(false);
  });
});
