"use client";

import { partialMessage } from "@/lib/vaultLoad";
import type { VaultsView } from "./useVaults";

/**
 * Rendered above any panel that lists vaults. Shown whenever the view is not
 * fully healthy: some vault reads failed (`partial`), or the id index could not
 * be refreshed while older data is still on screen (`syncing`).
 */
export function PartialLoadAlert({ view }: { view: VaultsView }) {
  if (view.status === "partial") {
    const ids = view.failedIds.map((i) => `#${i}`).join(", ");
    return (
      <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-crimson-100 bg-crimson-50 px-4 py-3 text-sm text-crimson-700">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-crimson-600" />
        <span className="min-w-0 flex-1">
          <strong className="font-semibold">{partialMessage(view)}</strong>
          <span className="ml-1 text-crimson-700/80">Not loaded: {ids}.</span>
        </span>
        <button onClick={view.retry} className="rounded-md border border-crimson-600/30 bg-white px-3 py-1 font-medium hover:bg-crimson-50">
          Retry
        </button>
      </div>
    );
  }
  if (view.status === "syncing" && view.vaults !== null) {
    return (
      <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-veto-100 bg-veto-50 px-4 py-3 text-sm text-veto-700">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-veto-600" />
        <span className="min-w-0 flex-1">
          <strong className="font-semibold">Could not refresh your vaults from RPC.</strong>
          <span className="ml-1">What is shown may be out of date and some vaults may be missing.</span>
        </span>
        <button onClick={view.retry} className="rounded-md border border-veto-600/30 bg-white px-3 py-1 font-medium hover:bg-veto-50">
          Retry
        </button>
      </div>
    );
  }
  return null;
}
