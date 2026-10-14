"use client";

import { useProtocol } from "./ProtocolProvider";

/**
 * Shown whenever the read path is failing. Panels render "—" for unknown values;
 * this banner is the explanation. It never lets a failed read masquerade as zero.
 */
export function SyncAlert() {
  const { status, syncMessage, refresh } = useProtocol();
  if (status !== "syncing") return null;
  return (
    <div role="alert" className="border-b border-veto-100 bg-veto-50">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-3 text-sm text-veto-700">
        <span className="h-2 w-2 animate-pulse rounded-full bg-veto-600" />
        <strong className="font-semibold">Network read syncing with Studio Next RPC.</strong>
        <span className="text-veto-700/80">
          Balances and vault state are unavailable rather than zero. Your funds are unaffected.
          {syncMessage ? ` (${syncMessage})` : ""}
        </span>
        <button onClick={refresh} className="ml-auto rounded-md border border-veto-600/30 bg-white px-3 py-1 font-medium hover:bg-veto-50">
          Retry now
        </button>
      </div>
    </div>
  );
}
