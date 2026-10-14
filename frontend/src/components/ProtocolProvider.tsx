"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { readView, describeError } from "@/lib/contract";
import { toOverview, toVault, type Overview, type VaultView } from "@/lib/types";

export type ReadStatus = "loading" | "ready" | "syncing";

interface ProtocolState {
  status: ReadStatus;
  /** null until a successful read: callers must render "—", never a fake zero. */
  overview: Overview | null;
  vaults: VaultView[] | null;
  syncMessage: string | null;
  refresh: () => void;
}

const Ctx = createContext<ProtocolState | null>(null);

export function useProtocol(): ProtocolState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProtocol outside ProtocolProvider");
  return v;
}

const PAGE = 25;

export function ProtocolProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ReadStatus>("loading");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [vaults, setVaults] = useState<VaultView[] | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    const ac = new AbortController();
    (async () => {
      try {
        const ov = toOverview(await readView("get_protocol_overview", [], ac.signal));
        const all: VaultView[] = [];
        for (let start = 1; start <= ov.vaultCount; start += PAGE) {
          const page = (await readView<any[]>("get_vault_summaries", [start, PAGE], ac.signal)) ?? [];
          for (const raw of page) all.push(toVault(raw));
        }
        if (gen !== generation.current) return; // a newer load superseded this one
        setOverview(ov);
        setVaults(all);
        setSyncMessage(null);
        setStatus("ready");
      } catch (e) {
        if ((e as Error)?.name === "AbortError" || gen !== generation.current) return;
        setSyncMessage(describeError(e));
        setStatus("syncing");
      }
    })();
    return () => ac.abort();
  }, [tick]);

  // Gentle background refresh; stale-while-syncing keeps the last good data.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const value = useMemo(
    () => ({ status, overview, vaults, syncMessage, refresh }),
    [status, overview, vaults, syncMessage, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
