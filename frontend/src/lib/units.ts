// Strict GEN <-> wei parsing. Everything that becomes `value` on a transaction
// goes through parseGenAmount; nothing here ever touches a JS float.

export const WEI_PER_GEN = 10n ** 18n;
export const MIN_DEPOSIT_WEI = 10n ** 15n; // mirrors the contract's MIN_DEPOSIT (0.001 GEN)

export type ParseResult = { ok: true; wei: bigint } | { ok: false; error: string };

// Plain decimal only: digits, optional single fractional part. No sign, no
// exponent, no hex, no separators, no leading/trailing dot.
const PLAIN_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;

export function parseGenAmount(input: string, opts: { min?: bigint } = {}): ParseResult {
  if (typeof input !== "string") return { ok: false, error: "Enter an amount in GEN." };
  const s = input.trim();
  if (s === "") return { ok: false, error: "Enter an amount in GEN." };
  if (s.startsWith("-")) return { ok: false, error: "Amount cannot be negative." };
  if (s.startsWith("+")) return { ok: false, error: "Remove the leading + sign." };
  if (/[eE]/.test(s) && !/^0[xX]/.test(s)) return { ok: false, error: "Scientific notation is not accepted; write the full decimal." };
  if (/^0[xX]/.test(s)) return { ok: false, error: "Hexadecimal amounts are not accepted." };
  if (/[,\s_]/.test(s)) return { ok: false, error: "Remove separators; use digits and one decimal point." };
  if (s.length > 40) return { ok: false, error: "Amount is too long." };
  if (!PLAIN_DECIMAL.test(s)) {
    if (/\.\d{19,}$/.test(s)) return { ok: false, error: "At most 18 decimal places." };
    return { ok: false, error: "Not a valid decimal amount (example: 1.25)." };
  }
  const [whole, frac = ""] = s.split(".");
  const wei = BigInt(whole) * WEI_PER_GEN + BigInt((frac + "0".repeat(18)).slice(0, 18));
  if (wei <= 0n) return { ok: false, error: "Amount must be greater than zero." };
  const min = opts.min ?? 0n;
  if (wei < min) return { ok: false, error: `Amount is below the protocol minimum of ${formatGen(min)} GEN.` };
  return { ok: true, wei };
}

/** Exact wei -> decimal GEN string, trimmed of trailing zeros (4 dp max shown by default). */
export function formatGen(wei: bigint | string | number, maxDecimals = 4): string {
  let v: bigint;
  try {
    v = typeof wei === "bigint" ? wei : BigInt(wei);
  } catch {
    return "—";
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = v / WEI_PER_GEN;
  const frac = (v % WEI_PER_GEN).toString().padStart(18, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

/** Whole-number input (inactivity days etc.): plain digits only. */
export function parseWholeNumber(input: string, min: number, max: number): { ok: true; value: number } | { ok: false; error: string } {
  const s = (input ?? "").trim();
  if (s === "") return { ok: false, error: "Enter a whole number." };
  if (s.startsWith("-")) return { ok: false, error: "Cannot be negative." };
  if (!/^(0|[1-9][0-9]{0,6})$/.test(s)) return { ok: false, error: "Digits only (no decimals or exponents)." };
  const n = Number(s);
  if (n < min || n > max) return { ok: false, error: `Must be between ${min} and ${max}.` };
  return { ok: true, value: n };
}
