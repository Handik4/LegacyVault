// Normalised views of the contract's JSON-shaped return values.

export const STATE = {
  ACTIVE: 0,
  CLAIM_INITIATED: 1,
  VETO: 2,
  SUCCEEDED: 3,
  REVOKED: 4,
} as const;

export interface Heir {
  address: string;
  bps: number;
  amount: bigint;
  claimed: boolean;
  noteRef: string;
}

export interface VaultView {
  id: number;
  owner: string;
  commitment: string;
  principal: bigint;
  state: number;
  stateName: string;
  createdAt: number;
  lastHeartbeat: number;
  threshold: number;
  claimableAt: number;
  executor: string;
  claimant: string;
  claimBond: bigint;
  claimStartedAt: number;
  vetoUntil: number;
  certEpoch: number;
  certHash: string;
  verifyAttempts: number;
  requiredBond: bigint;
  heirs: Heir[];
}

export interface RegistryView {
  index: number;
  baseUrl: string;
  host: string;
  pendingUrl: string;
  pendingAt: number;
}

export interface Overview {
  vaultCount: number;
  escrowed: bigint;
  balance: bigint;
  solvent: boolean;
  governor: string;
  registries: RegistryView[];
  minDeposit: bigint;
  minClaimBond: bigint;
  claimBondBps: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const big = (v: unknown): bigint => {
  try {
    return BigInt(v as string | number | bigint);
  } catch {
    return 0n;
  }
};
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export function toVault(raw: any): VaultView {
  return {
    id: num(raw.vault_id),
    owner: str(raw.owner),
    commitment: str(raw.identity_commitment),
    principal: big(raw.principal),
    state: num(raw.state),
    stateName: str(raw.state_name),
    createdAt: num(raw.created_at),
    lastHeartbeat: num(raw.last_heartbeat),
    threshold: num(raw.inactivity_threshold),
    claimableAt: num(raw.claimable_at),
    executor: str(raw.executor),
    claimant: str(raw.claimant),
    claimBond: big(raw.claim_bond),
    claimStartedAt: num(raw.claim_started_at),
    vetoUntil: num(raw.veto_until),
    certEpoch: num(raw.cert_epoch),
    certHash: str(raw.cert_hash),
    verifyAttempts: num(raw.verify_attempts),
    requiredBond: big(raw.required_bond),
    heirs: (Array.isArray(raw.beneficiaries) ? raw.beneficiaries : []).map((b: any) => ({
      address: str(b.address),
      bps: num(b.bps),
      amount: big(b.amount),
      claimed: Boolean(b.claimed),
      noteRef: str(b.note_ref),
    })),
  };
}

export function toOverview(raw: any): Overview {
  const c = raw?.constants ?? {};
  return {
    vaultCount: num(raw.vault_count),
    escrowed: big(raw.escrowed),
    balance: big(raw.balance),
    solvent: Boolean(raw.solvent),
    governor: str(raw.governor),
    registries: (Array.isArray(raw.registries) ? raw.registries : []).map((r: any) => ({
      index: num(r.index),
      baseUrl: str(r.base_url),
      host: str(r.host),
      pendingUrl: str(r.pending_url),
      pendingAt: num(r.pending_at),
    })),
    minDeposit: big(c.min_deposit),
    minClaimBond: big(c.min_claim_bond),
    claimBondBps: num(c.claim_bond_bps),
  };
}

export const sameAddress = (a: string, b: string | null | undefined): boolean =>
  !!b && a.toLowerCase() === b.toLowerCase();
