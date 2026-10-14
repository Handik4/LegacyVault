"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SerialLoader, describeError, readView } from "@/lib/contract";
import { toOverview, toVault } from "@/lib/types";
import {
  applyVault,
  failCycle,
  finishCycle,
  initialVaultsState,
  loadByIds,
  type CycleResult,
  type VaultsState,
} from "@/lib/vaultLoad";
import type { VaultView } from "@/lib/types";
import { useProtocol } from "./ProtocolProvider";

export type { VaultsState } from "@/lib/vaultLoad";
export interface VaultsView extends VaultsState {
  /** Re-run the load now (coalesced if a read is already running). */
  retry: () => void;
}

const POLL_MS = 30_000;

function useLoader(
  scope: string | null,
  load: (signal: AbortSignal, onVault: (v: VaultView) => void) => Promise<CycleResult>,
): VaultsView {
  const { refreshToken } = useProtocol();
  const [state, setState] = useState<VaultsState>(initialVaultsState);
  const loaderRef = useRef<SerialLoader | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (scope === null) return;
    const loader = new SerialLoader(async (signal) => {
      try {
        const result = await loadRef.current(signal, (v) => {
          if (!signal.aborted) setState((s) => applyVault(s, v));
        });
        if (signal.aborted) return;
        setState((s) => finishCycle(s, result));
      } catch (e) {
        if ((e as Error)?.name === "AbortError" || signal.aborted) return;
        setState((s) => failCycle(s, describeError(e)));
      }
    });
    loaderRef.current = loader;
    loader.refresh();
    const id = setInterval(() => loader.poll(), POLL_MS);
    return () => {
      clearInterval(id);
      loader.dispose();
      loaderRef.current = null;
    };
  }, [scope]);

  // Re-read after a transaction. Coalesced by the loader if a read is running.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    loaderRef.current?.refresh();
  }, [refreshToken]);

  const retry = useCallback(() => loaderRef.current?.refresh(), []);
  return { ...state, retry };
}

/**
 * One account's vaults (owned, beneficiary of, or executed). Targeted reads only:
 * `get_vault_ids_for` then `get_vault` per id, rendered as each record arrives.
 *
 * Health is per cycle: the view is `ready` only when every indexed id resolved;
 * otherwise it is `partial` with `failedIds`, however many other reads succeeded.
 */
export function useAccountVaults(account: string | null): VaultsView {
  return useLoader(account, async (signal, onVault) => {
    const raw = (await readView<unknown[]>("get_vault_ids_for", [account], signal)) ?? [];
    const ids = raw.map(Number);
    return loadByIds(ids, async (id) => toVault(await readView("get_vault", [id], signal)), onVault);
  });
}

const PAGE = 25;

/** Every vault, paged. Only the Registries tab uses this (for its vault picker). */
export function useAllVaults(enabled: boolean): VaultsView {
  return useLoader(enabled ? "all" : null, async (signal, onVault) => {
    const ov = toOverview(await readView("get_protocol_overview", [], signal));
    const failedIds: number[] = [];
    for (let start = 1; start <= ov.vaultCount; start += PAGE) {
      try {
        const page = (await readView<any[]>("get_vault_summaries", [start, PAGE], signal)) ?? [];
        page.forEach((raw) => onVault(toVault(raw)));
      } catch (e) {
        if ((e as Error)?.name === "AbortError") throw e;
        // A failed page is a failed range, never silently skipped.
        for (let id = start; id < Math.min(start + PAGE, ov.vaultCount + 1); id++) failedIds.push(id);
      }
    }
    return { expected: ov.vaultCount, failedIds };
  });
}
