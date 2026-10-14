// Identity commitment: SHA-256 of `full_name|birth_date|jurisdiction_id`.
// Normalisation is part of the protocol (a registry computes the same bytes):
//   full_name        NFC, trimmed, internal whitespace collapsed, lower-cased
//   birth_date       YYYY-MM-DD (calendar-valid)
//   jurisdiction_id  trimmed, upper-cased, [A-Z0-9_-]{2,32}
// Nothing here is ever sent anywhere; only the 64-hex digest goes on-chain.

export interface IdentityInput {
  fullName: string;
  birthDate: string;
  jurisdictionId: string;
}

export type IdentityResult = { ok: true; preimage: string } | { ok: false; error: string };

export function identityPreimage(i: IdentityInput): IdentityResult {
  const name = (i.fullName ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  if (name.length < 2) return { ok: false, error: "Enter the legal full name." };
  if (name.includes("|")) return { ok: false, error: "Full name cannot contain the | character." };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((i.birthDate ?? "").trim());
  if (!m) return { ok: false, error: "Birth date must be YYYY-MM-DD." };
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return { ok: false, error: "Birth date is not a real calendar date." };
  }
  const jur = (i.jurisdictionId ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(jur)) return { ok: false, error: "Jurisdiction id must be 2-32 chars of A-Z, 0-9, - or _." };
  return { ok: true, preimage: `${name}|${m[0]}|${jur}` };
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function identityCommitment(i: IdentityInput): Promise<{ ok: true; commitment: string } | { ok: false; error: string }> {
  const p = identityPreimage(i);
  if (!p.ok) return p;
  return { ok: true, commitment: await sha256Hex(p.preimage) };
}
