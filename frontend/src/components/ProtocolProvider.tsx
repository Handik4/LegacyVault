"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SerialLoader, describeError, readView } from "@/lib/contract";
import { toOverview, type Overview } from "@/lib/types";

export type ReadStatus = "loading" | "ready" | "syncing";

interface ProtocolState {
  status: ReadStatus;
  /** null until a successful read: callers must render "—", never a fake zero. */
  overview: Overview | null;
  syncMessage: string | null;
  /**
   * Increments on every explicit refresh (e.g. after a transaction). Per-account
   * hooks watch it to re-read their own records.
   */
  refreshToken: number;
  refresh: () => void;
}

const Ctx = createContext<ProtocolState | null>(null);

export function useProtocol(): ProtocolState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProtocol outside ProtocolProvider");
  return v;
}

const POLL_MS = 30_000;

/**
 * Holds only the protocol overview: one cheap read. Vault records are loaded by
 * the panels that need them (useAccountVaults / useAllVaults), so no panel waits
 * on a full-history traversal and the poll below can never abort one.
 */
export function ProtocolProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ReadStatus>("loading");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const loaderRef = useRef<SerialLoader | null>(null);

  useEffect(() => {
    const loader = new SerialLoader(async (signal) => {
      try {
        const ov = toOverview(await readView("get_protocol_overview", [], signal));
        if (signal.aborted) return;
        setOverview(ov);
        setSyncMessage(null);
        setStatus("ready");
      } catch (e) {
        if ((e as Error)?.name === "AbortError" || signal.aborted) return;
        // Keep the last good overview; the banner explains it may be stale.
        setSyncMessage(describeError(e));
        setStatus("syncing");
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
  }, []);

  const refresh = useCallback(() => {
    loaderRef.current?.refresh();
    setRefreshToken((t) => t + 1);
  }, []);

  const value = useMemo(
    () => ({ status, overview, syncMessage, refreshToken, refresh }),
    [status, overview, syncMessage, refreshToken, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
