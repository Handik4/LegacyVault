import { describe, expect, it } from "vitest";
import { MIN_DEPOSIT_WEI, WEI_PER_GEN, formatGen, parseGenAmount, parseWholeNumber } from "../units";

describe("parseGenAmount", () => {
  it("parses whole and fractional amounts exactly", () => {
    expect(parseGenAmount("1")).toEqual({ ok: true, wei: WEI_PER_GEN });
    expect(parseGenAmount("0.5")).toEqual({ ok: true, wei: WEI_PER_GEN / 2n });
    expect(parseGenAmount("12.000000000000000001")).toEqual({ ok: true, wei: 12n * WEI_PER_GEN + 1n });
    expect(parseGenAmount("  2.5 ")).toEqual({ ok: true, wei: 5n * WEI_PER_GEN / 2n });
  });
  it("is exact where floats are not", () => {
    // 0.1 + 0.2 style traps: 9007199254740993 GEN is beyond float precision
    const r = parseGenAmount("9007199254740993");
    expect(r).toEqual({ ok: true, wei: 9007199254740993n * WEI_PER_GEN });
  });
  it.each(["", "   "])("rejects empty input %j", (s) => {
    expect(parseGenAmount(s).ok).toBe(false);
  });
  it.each(["0", "0.0", "0.000000000000000000", "00"])("rejects zero %j", (s) => {
    expect(parseGenAmount(s).ok).toBe(false);
  });
  it.each(["-1", "-0.5", "-0", "-1e3"])("rejects negatives %j", (s) => {
    const r = parseGenAmount(s);
    expect(r.ok).toBe(false);
  });
  it.each(["1e3", "1E3", "2.5e-1", "1e18", "1e+2"])("rejects scientific notation %j", (s) => {
    const r = parseGenAmount(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("scientific");
  });
  it.each(["0x10", "0X1f", "abc", "1.2.3", ".5", "5.", "1,000", "1 000", "1_000", "NaN", "Infinity", "+1", "١٢"])(
    "rejects malformed %j",
    (s) => {
      expect(parseGenAmount(s).ok).toBe(false);
    },
  );
  it("rejects more than 18 decimals", () => {
    expect(parseGenAmount("0.0000000000000000001").ok).toBe(false);
  });
  it("enforces a minimum", () => {
    expect(parseGenAmount("0.0009", { min: MIN_DEPOSIT_WEI }).ok).toBe(false);
    expect(parseGenAmount("0.001", { min: MIN_DEPOSIT_WEI }).ok).toBe(true);
  });
});

describe("formatGen", () => {
  it("formats exactly and trims zeros", () => {
    expect(formatGen(WEI_PER_GEN)).toBe("1");
    expect(formatGen(WEI_PER_GEN / 2n)).toBe("0.5");
    expect(formatGen("10000000000000000")).toBe("0.01");
    expect(formatGen("not a number")).toBe("—");
  });
});

describe("parseWholeNumber", () => {
  it("accepts plain integers within bounds", () => {
    expect(parseWholeNumber("90", 90, 3650)).toEqual({ ok: true, value: 90 });
  });
  it.each(["89", "3651", "-90", "90.5", "1e2", "", "abc", "090"])("rejects %j", (s) => {
    expect(parseWholeNumber(s, 90, 3650).ok).toBe(false);
  });
});
