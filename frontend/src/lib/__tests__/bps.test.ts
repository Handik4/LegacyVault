import { describe, expect, it } from "vitest";
import { checkShares, evenShares, splitShares } from "../bps";

describe("splitShares", () => {
  it("assigns the integer remainder to heir 0 and loses no wei", () => {
    const principal = 1_000_000_000_000_007n;
    const out = splitShares(principal, [1000, 3000, 6000]);
    const floor = [1000n, 3000n, 6000n].map((b) => (principal * b) / 10_000n);
    const remainder = principal - floor.reduce((a, b) => a + b, 0n);
    expect(remainder).toBeGreaterThan(0n);
    expect(out).toEqual([floor[0] + remainder, floor[1], floor[2]]);
    expect(out.reduce((a, b) => a + b, 0n)).toBe(principal);
  });
  it.each([[[3333, 3333, 3334]], [[1, 9999]], [[1, 1, 1, 1, 9996]], [[10000]]])("sums to principal for %j", (shares) => {
    for (const p of [1n, 7n, 999n, 10n ** 18n + 13n]) {
      expect(splitShares(p, shares).reduce((a, b) => a + b, 0n)).toBe(p);
    }
  });
});

describe("checkShares", () => {
  it("requires exactly 10000 bps", () => {
    expect(checkShares([6000, 4000]).ok).toBe(true);
    expect(checkShares([6000, 3999]).ok).toBe(false);
    expect(checkShares([6000, 4001]).ok).toBe(false);
  });
  it("bounds beneficiary count and share validity", () => {
    expect(checkShares([]).ok).toBe(false);
    expect(checkShares([2000, 2000, 2000, 2000, 1000, 1000]).ok).toBe(false);
    expect(checkShares([10001, -1]).ok).toBe(false);
    expect(checkShares([0, 10000]).ok).toBe(false);
    expect(checkShares([5000.5, 4999.5]).ok).toBe(false);
  });
  it("evenShares always totals 10000", () => {
    for (let n = 1; n <= 5; n++) expect(evenShares(n).reduce((a, b) => a + b, 0)).toBe(10_000);
  });
});
