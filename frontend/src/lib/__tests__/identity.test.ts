import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { identityCommitment, identityPreimage } from "../identity";

describe("identity commitment", () => {
  it("normalises name, date and jurisdiction into the protocol preimage", () => {
    expect(identityPreimage({ fullName: "  Ada   LOVELACE ", birthDate: "1815-12-10", jurisdictionId: " gb-lnd " })).toEqual({
      ok: true,
      preimage: "ada lovelace|1815-12-10|GB-LND",
    });
  });
  it("matches Python hashlib sha256 of the same preimage (contract/test parity)", async () => {
    const r = await identityCommitment({ fullName: "Ada Lovelace", birthDate: "1815-12-10", jurisdictionId: "GB-LND" });
    const expected = createHash("sha256").update("ada lovelace|1815-12-10|GB-LND").digest("hex");
    expect(r).toEqual({ ok: true, commitment: expected });
  });
  it("is stable under case and whitespace differences", async () => {
    const a = await identityCommitment({ fullName: "ADA LOVELACE", birthDate: "1815-12-10", jurisdictionId: "gb-lnd" });
    const b = await identityCommitment({ fullName: "ada  lovelace", birthDate: "1815-12-10", jurisdictionId: "GB-LND" });
    expect(a).toEqual(b);
  });
  it("rejects impossible calendar dates and bad inputs", () => {
    expect(identityPreimage({ fullName: "A B", birthDate: "2026-02-30", jurisdictionId: "GB" }).ok).toBe(false);
    expect(identityPreimage({ fullName: "A B", birthDate: "10/12/1815", jurisdictionId: "GB" }).ok).toBe(false);
    expect(identityPreimage({ fullName: "", birthDate: "1815-12-10", jurisdictionId: "GB" }).ok).toBe(false);
    expect(identityPreimage({ fullName: "A|B", birthDate: "1815-12-10", jurisdictionId: "GB" }).ok).toBe(false);
    expect(identityPreimage({ fullName: "A B", birthDate: "1815-12-10", jurisdictionId: "!" }).ok).toBe(false);
  });
});
