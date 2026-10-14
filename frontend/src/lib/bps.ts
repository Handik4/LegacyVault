// Basis-point heir allocation. Mirrors contracts/legacy_vault.py::_split_shares:
// floor(principal * bps / 10000) per heir, remainder to heir index 0 so the sum
// always equals the principal exactly (zero dust).

export const BPS_TOTAL = 10_000;
export const MAX_HEIRS = 5;

export function splitShares(principal: bigint, bps: number[]): bigint[] {
  const amounts = bps.map((b) => (principal * BigInt(b)) / BigInt(BPS_TOTAL));
  const assigned = amounts.reduce((a, b) => a + b, 0n);
  if (amounts.length > 0) amounts[0] += principal - assigned;
  return amounts;
}

export type BpsCheck = { ok: true; total: number } | { ok: false; total: number; error: string };

export function checkShares(bps: number[]): BpsCheck {
  const total = bps.reduce((a, b) => a + b, 0);
  if (bps.length < 1) return { ok: false, total, error: "Add at least one beneficiary." };
  if (bps.length > MAX_HEIRS) return { ok: false, total, error: `At most ${MAX_HEIRS} beneficiaries.` };
  if (bps.some((b) => !Number.isInteger(b) || b <= 0)) return { ok: false, total, error: "Every share must be a positive whole number of bps." };
  if (total !== BPS_TOTAL) {
    return { ok: false, total, error: `Shares total ${total} bps; they must total exactly ${BPS_TOTAL}.` };
  }
  return { ok: true, total };
}

/** Even split in bps that always sums to 10000 (remainder to the first heir). */
export function evenShares(n: number): number[] {
  if (n < 1) return [];
  const base = Math.floor(BPS_TOTAL / n);
  const out = Array<number>(n).fill(base);
  out[0] += BPS_TOTAL - base * n;
  return out;
}

export const bpsToPercent = (bps: number): string => `${(bps / 100).toFixed(2)}%`;
