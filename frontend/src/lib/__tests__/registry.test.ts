import { describe, expect, it } from "vitest";
import { DAY, aggregate, evaluateRecord, parseIsoDay, type SourceOutcome } from "../registry";

const COMMIT = "a".repeat(64);
const CERT = "ab".repeat(32);
const day = (s: string) => parseIsoDay(s);
const ctx = {
  commitment: COMMIT,
  creationDay: day("2026-01-01"),
  now: day("2026-04-11") + 3600,
  lastHeartbeat: day("2026-01-01"),
};
const rec = (over: Record<string, unknown> = {}) => ({
  schema: "legacyvault.vital-record/v1",
  identity_commitment: COMMIT,
  status: "CONFIRMED",
  certificate_hash: CERT,
  date_of_death: "2026-02-10",
  ...over,
});
const out = (state: SourceOutcome["state"], cert = CERT, death = day("2026-02-10")): SourceOutcome => ({
  state,
  certHash: state === "confirmed" ? cert : "",
  deathEpoch: state === "confirmed" ? death : 0,
  detail: "",
});

describe("evaluateRecord (mirror of contract _evaluate_record)", () => {
  it("confirms a valid record", () => {
    expect(evaluateRecord(rec(), ctx)).toMatchObject({ state: "confirmed", deathEpoch: day("2026-02-10") });
  });
  it("rejects a certificate predating vault creation", () => {
    expect(evaluateRecord(rec({ date_of_death: "2025-12-31" }), ctx).state).toBe("unconfirmed");
  });
  it("accepts a death on the creation day", () => {
    expect(evaluateRecord(rec({ date_of_death: "2026-01-01" }), ctx).state).toBe("confirmed");
  });
  it("rejects future-dated deaths", () => {
    expect(evaluateRecord(rec({ date_of_death: "2026-04-12" }), ctx).state).toBe("unconfirmed");
  });
  it("rejects a death that precedes the owner's last heartbeat", () => {
    const c = { ...ctx, lastHeartbeat: day("2026-03-02") };
    expect(evaluateRecord(rec({ date_of_death: "2026-02-10" }), c).state).toBe("unconfirmed");
    expect(evaluateRecord(rec({ date_of_death: "2026-03-02" }), c).state).toBe("confirmed");
  });
  it.each([
    [{ status: "PENDING" }],
    [{ status: "confirmed" }],
    [{ identity_commitment: "b".repeat(64) }],
    [{ certificate_hash: "xyz" }],
    [{ date_of_death: "2026-02-30" }],
    [{ schema: "other" }],
  ])("rejects %j", (over) => {
    expect(evaluateRecord(rec(over as Record<string, unknown>), ctx).state).toBe("unconfirmed");
  });
  it("only an exact REVOKED status for this identity is active dissent", () => {
    expect(evaluateRecord(rec({ status: "REVOKED" }), ctx).state).toBe("revoked");
    expect(evaluateRecord(rec({ status: "REVOKED", identity_commitment: "b".repeat(64) }), ctx).state).toBe("unconfirmed");
    expect(evaluateRecord(rec({ status: "revoked" }), ctx).state).toBe("unconfirmed");
    expect(evaluateRecord(rec({ status: "ALIVE" }), ctx).state).toBe("unconfirmed");
  });
  it("rejects non-objects", () => {
    for (const v of [null, [], "x", 1]) expect(evaluateRecord(v, ctx).state).toBe("unconfirmed");
  });
});

describe("aggregate (mirror of contract _aggregate)", () => {
  it("3-of-3 agreement verifies", () => {
    expect(aggregate([out("confirmed"), out("confirmed"), out("confirmed")])).toMatchObject({ code: 1, sourceCount: 3 });
  });
  it("2-of-3 quorum verifies when one source is down", () => {
    expect(aggregate([out("confirmed"), out("unreachable"), out("confirmed")])).toMatchObject({ code: 1, sourceCount: 2 });
  });
  it("fewer than two responders is QUORUM_FAILURE", () => {
    expect(aggregate([out("confirmed"), out("unreachable"), out("unreachable")])).toMatchObject({ code: 2, sourceCount: 1 });
    expect(aggregate([out("unreachable"), out("unreachable"), out("unreachable")])).toMatchObject({ code: 2, sourceCount: 0 });
  });
  it("a lagging 404 abstains and cannot veto two matching confirmations", () => {
    for (const slot of [0, 1, 2]) {
      const o = [out("confirmed"), out("confirmed"), out("confirmed")];
      o[slot] = out("absent");
      expect(aggregate(o)).toMatchObject({ code: 1, sourceCount: 2 });
    }
  });
  it("generic unconfirmed records abstain like a 404", () => {
    expect(aggregate([out("confirmed"), out("confirmed"), out("unconfirmed")]).code).toBe(1);
  });
  it("an explicit REVOKED record is active dissent", () => {
    expect(aggregate([out("confirmed"), out("confirmed"), out("revoked")])).toMatchObject({ code: 0, sourceCount: 3 });
    expect(aggregate([out("confirmed"), out("revoked"), out("unreachable")]).code).toBe(0);
  });
  it("[CONFIRMED, 404, outage] is QUORUM_FAILURE, not a slash", () => {
    expect(aggregate([out("confirmed"), out("absent"), out("unreachable")])).toMatchObject({ code: 2, sourceCount: 2 });
    expect(aggregate([out("unreachable"), out("absent"), out("confirmed")]).code).toBe(2);
    expect(aggregate([out("confirmed"), out("unconfirmed"), out("unreachable")]).code).toBe(2);
  });
  it("NO_RECORD only when 2-of-3 confirmation is impossible", () => {
    expect(aggregate([out("absent"), out("absent"), out("absent")]).code).toBe(0);
    expect(aggregate([out("absent"), out("absent"), out("unreachable")])).toMatchObject({ code: 0, sourceCount: 2 });
    expect(aggregate([out("confirmed"), out("absent"), out("absent")]).code).toBe(0);
  });
  it("conflicting certificates block verification", () => {
    expect(aggregate([out("confirmed"), out("confirmed", "cd".repeat(32)), out("confirmed")]).code).toBe(0);
    expect(aggregate([out("confirmed"), out("confirmed", "cd".repeat(32)), out("unreachable")]).code).toBe(0);
    expect(aggregate([out("confirmed"), out("confirmed", CERT, day("2026-02-11")), out("confirmed")]).code).toBe(0);
  });
  it("DAY constant matches the contract", () => {
    expect(DAY).toBe(86400);
  });
});
