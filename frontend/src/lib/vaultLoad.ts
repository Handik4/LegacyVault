// Vault-list load state, as pure functions so the safety property is testable:
//
//   A single vault read succeeding must NEVER make a failed read disappear.
//
// An owner who sees a "Ready" panel listing only vault #2 would never learn that
// vault #1, which may urgently need a heartbeat or a veto, did not load. Health is
// therefore decided once per load cycle, from the failure set of THAT cycle, and
// individual arrivals only add records to the view.

import type { VaultView } from "./types";

export type VaultsStatus = "loading" | "ready" | "partial" | "syncing";

export interface VaultsState {
  status: VaultsStatus;
  /** null until the first record arrives or a cycle completes: unknown, not empty. */
  vaults: VaultView[] | null;
  /** Vault ids whose read failed in the most recent COMPLETED cycle. */
  failedIds: number[];
  /** How many vaults the account index said this view should contain. */
  expected: number;
  /** The id index itself could not be read (nothing is known to be missing or not). */
  error: string | null;
}

export const initialVaultsState: VaultsState = {
  status: "loading",
  vaults: null,
  failedIds: [],
  expected: 0,
  error: null,
};

export interface CycleResult {
  expected: number;
  failedIds: number[];
}

/**
 * A record arrived. Adds/updates it in the view and touches NOTHING else:
 * not `status`, not `failedIds`, not `error`. This is the line that used to
 * clear the error flag.
 */
export function applyVault(s: VaultsState, v: VaultView): VaultsState {
  const byId = new Map((s.vaults ?? []).map((x) => [x.id, x] as const));
  byId.set(v.id, v);
  return { ...s, vaults: [...byId.values()].sort((a, b) => a.id - b.id) };
}

/**
 * A cycle finished. Healthy only if EVERY indexed vault resolved: any failure
 * leaves the view `partial` and names the failed ids.
 */
export function finishCycle(s: VaultsState, r: CycleResult): VaultsState {
  const failedIds = [...new Set(r.failedIds)].sort((a, b) => a - b);
  return {
    status: failedIds.length === 0 ? "ready" : "partial",
    vaults: s.vaults ?? [],
    failedIds,
    expected: r.expected,
    error: null,
  };
}

/** The id index (or a page of it) could not be read. Keeps whatever is on screen. */
export function failCycle(s: VaultsState, error: string): VaultsState {
  return { ...s, status: "syncing", error };
}

/**
 * Reads every id with allSettled (never short-circuits on the first rejection)
 * and reports the failures. `onVault` is called as each record arrives so the
 * panel can render records progressively.
 */
export async function loadByIds(
  ids: number[],
  readOne: (id: number) => Promise<VaultView>,
  onVault: (v: VaultView) => void,
): Promise<CycleResult> {
  const settled = await Promise.allSettled(
    ids.map(async (id) => {
      const v = await readOne(id);
      onVault(v);
      return id;
    }),
  );
  const failedIds: number[] = [];
  settled.forEach((r, i) => {
    if (r.status === "rejected") failedIds.push(ids[i]);
  });
  return { expected: ids.length, failedIds };
}

export function partialMessage(s: Pick<VaultsState, "failedIds" | "expected">): string {
  return `Warning: ${s.failedIds.length} of ${s.expected} vaults failed to load from RPC. Critical heartbeat or veto actions may be hidden.`;
}
