// Client-side mirror of the contract's registry record evaluation, used by the
// Registry Inspector to PREVIEW what validators will see. The on-chain check is
// authoritative; this never gates a transaction.

export const RECORD_SCHEMA = "legacyvault.vital-record/v1";
export const DAY = 86_400;
export const MIN_SOURCES = 2;

/**
 * confirmed    valid CONFIRMED record for this vault (positive proof)
 * revoked      record for this vault with status exactly REVOKED (active dissent)
 * absent       clean 404/410: no record at this source (abstains)
 * unconfirmed  any other well-formed record (other identity, generic status,
 *              unusable date/hash): abstains exactly like a 404
 * unreachable  outage / 5xx / foreign schema: not a responder
 */
export type SourceState = "confirmed" | "revoked" | "absent" | "unconfirmed" | "unreachable";

export interface SourceOutcome {
  state: SourceState;
  certHash: string;
  deathEpoch: number;
  detail: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function parseIsoDay(text: unknown): number {
  if (typeof text !== "string") return -1;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return -1;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const probe = new Date(t);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return -1;
  return Math.floor(t / 1000);
}

export interface EvalContext {
  commitment: string;
  creationDay: number;
  now: number;
  lastHeartbeat: number;
}

export function evaluateRecord(record: unknown, ctx: EvalContext): SourceOutcome {
  const no = (detail: string): SourceOutcome => ({ state: "unconfirmed", certHash: "", deathEpoch: 0, detail });
  if (record === null || typeof record !== "object" || Array.isArray(record)) return no("Record is not a JSON object.");
  const r = record as Record<string, unknown>;
  if (r.schema !== RECORD_SCHEMA) return no("Unrecognised record schema.");
  if (typeof r.identity_commitment !== "string" || r.identity_commitment.toLowerCase() !== ctx.commitment) {
    return no("Record names a different identity commitment.");
  }
  if (r.status === "REVOKED") {
    return { state: "revoked", certHash: "", deathEpoch: 0, detail: "Registry explicitly REVOKED this record." };
  }
  if (r.status !== "CONFIRMED") return no(`Status is ${String(r.status)}, not CONFIRMED.`);
  if (typeof r.certificate_hash !== "string" || !HEX64.test(r.certificate_hash.toLowerCase())) {
    return no("Certificate hash is not a 64-char hex digest.");
  }
  const death = parseIsoDay(r.date_of_death);
  if (death < 0) return no("Date of death is not a valid YYYY-MM-DD date.");
  if (death < ctx.creationDay) return no("Certificate predates the vault's creation.");
  if (death > ctx.now) return no("Date of death is in the future.");
  if (death + DAY <= ctx.lastHeartbeat) return no("Owner acted after the recorded date of death.");
  return { state: "confirmed", certHash: r.certificate_hash.toLowerCase(), deathEpoch: death, detail: "Valid confirmed certificate." };
}

export type Verdict = "NO_RECORD_FOUND" | "VERIFIED_DECEASED" | "QUORUM_FAILURE";

export interface Consensus {
  verdict: Verdict;
  code: 0 | 1 | 2;
  sourceCount: number;
  certEpoch: number;
}

/**
 * Collapse per-source outcomes exactly as the contract's _aggregate does.
 * Order: (1) <2 responders -> QUORUM_FAILURE; (2) active dissent (a REVOKED
 * record, or CONFIRMED records that conflict on hash/epoch) -> NO_RECORD;
 * (3) >=2 matching CONFIRMED -> VERIFIED; (4) confirmed + unreachable could
 * still reach 2 -> QUORUM_FAILURE (never slashes on an outage); (5) else
 * NO_RECORD. 404s and generic unconfirmed records abstain.
 */
export function aggregate(outcomes: SourceOutcome[]): Consensus {
  const responded = outcomes.filter((o) => o.state !== "unreachable");
  const n = responded.length;
  const down = outcomes.length - n;
  if (n < MIN_SOURCES) return { verdict: "QUORUM_FAILURE", code: 2, sourceCount: n, certEpoch: 0 };
  const confirmed = responded.filter((o) => o.state === "confirmed");
  const revoked = responded.some((o) => o.state === "revoked");
  const certs = new Set(confirmed.map((o) => `${o.certHash}:${o.deathEpoch}`));
  if (revoked || certs.size > 1) return { verdict: "NO_RECORD_FOUND", code: 0, sourceCount: n, certEpoch: 0 };
  if (confirmed.length >= MIN_SOURCES) {
    return { verdict: "VERIFIED_DECEASED", code: 1, sourceCount: confirmed.length, certEpoch: confirmed[0].deathEpoch };
  }
  if (confirmed.length + down >= MIN_SOURCES) return { verdict: "QUORUM_FAILURE", code: 2, sourceCount: n, certEpoch: 0 };
  return { verdict: "NO_RECORD_FOUND", code: 0, sourceCount: n, certEpoch: 0 };
}
