"use client";

import { useEffect, useRef, useState } from "react";
import { SerialLoader, describeError, readView } from "@/lib/contract";
import { toOverview, toVault, type VaultView } from "@/lib/types";
import { useProtocol } from "./ProtocolProvider";

export interface VaultsState {
  status: "loading" | "ready" | "syncing";
  /** null until the first successful read; never an empty array standing in for "unknown". */
  vaults: VaultView[] | null;
  error: string | null;
}

const POLL_MS = 30_000;

function useLoader(
  scope: string | null,
  load: (signal: AbortSignal, upsert: (v: VaultView[]) => void) => Promise<void>,
): VaultsState {
  const { refreshToken } = useProtocol();
  const [state, setState] = useState<VaultsState>({ status: "loading", vaults: null, error: null });
  const loaderRef = useRef<SerialLoader | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (scope === null) return;
    const loader = new SerialLoader(async (signal) => {
      try {
        await loadRef.current(signal, (batch) => {
          if (signal.aborted) return;
          setState((prev) => {
            const byId = new Map((prev.vaults ?? []).map((v) => [v.id, v] as const));
            for (const v of batch) byId.set(v.id, v);
            return { status: "ready", vaults: [...byId.values()].sort((a, b) => a.id - b.id), error: null };
          });
        });
        if (signal.aborted) return;
        // An account that owns nothing still completes: [] is a real answer here.
        setState((prev) => ({ status: "ready", vaults: prev.vaults ?? [], error: null }));
      } catch (e) {
        if ((e as Error)?.name === "AbortError" || signal.aborted) return;
        setState((prev) => ({ status: "syncing", vaults: prev.vaults, error: describeError(e) }));
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

  return state;
}

/**
 * One account's vaults (owned, beneficiary of, or executed). Targeted reads only:
 * `get_vault_ids_for` then `get_vault` per id, rendered as each record arrives.
 * The full `get_vault` record is used on purpose: the summary view strips the
 * heir note references, which is why notes used to vanish on reload.
 */
export function useAccountVaults(account: string | null): VaultsState {
  return useLoader(account, async (signal, upsert) => {
    const ids = (await readView<unknown[]>("get_vault_ids_for", [account], signal)) ?? [];
    await Promise.all(
      ids.map(async (raw) => {
        const id = Number(raw);
        const v = toVault(await readView("get_vault", [id], signal));
        upsert([v]);
      }),
    );
  });
}

const PAGE = 25;

/** Every vault, paged. Only the Registries tab uses this (for its vault picker). */
export function useAllVaults(enabled: boolean): VaultsState {
  return useLoader(enabled ? "all" : null, async (signal, upsert) => {
    const ov = toOverview(await readView("get_protocol_overview", [], signal));
    for (let start = 1; start <= ov.vaultCount; start += PAGE) {
      const page = (await readView<any[]>("get_vault_summaries", [start, PAGE], signal)) ?? [];
      upsert(page.map(toVault));
    }
  });
}
