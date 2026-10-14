"use client";

import { useWallet } from "./WalletProvider";
import { Button, short } from "./ui";

export function Header() {
  const { account, connect, disconnect, connecting, chainOk, switchChain, error } = useWallet();
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-alabaster/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-forest-800 font-serif text-sm text-white" aria-hidden>
            LV
          </span>
          <div>
            <p className="font-serif text-lg leading-none text-ink">LegacyVault</p>
            <p className="mt-0.5 text-[11px] uppercase tracking-[0.16em] text-slate-500">Digital estate &amp; succession</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {account && !chainOk && (
            <button onClick={() => void switchChain()} className="rounded-full border border-crimson-100 bg-crimson-50 px-3 py-1 text-xs font-medium text-crimson-700">
              Wrong network: switch to Studio Next
            </button>
          )}
          {account ? (
            <>
              <span className="hidden items-center gap-2 rounded-full border border-forest-100 bg-forest-50 px-3 py-1 text-xs font-medium text-forest-800 sm:inline-flex" title={account}>
                <span className="h-1.5 w-1.5 rounded-full bg-forest-600" />
                {short(account, 5)}
              </span>
              <Button variant="ghost" onClick={() => void disconnect()}>Disconnect</Button>
            </>
          ) : (
            <Button onClick={() => void connect()} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect wallet"}
            </Button>
          )}
        </div>
      </div>
      {error && <p className="bg-crimson-50 px-6 py-1.5 text-center text-xs text-crimson-700">{error}</p>}
    </header>
  );
}
