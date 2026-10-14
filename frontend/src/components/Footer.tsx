"use client";

import { useState } from "react";
import { CONTRACT_ADDRESS, NETWORK, explorerAddress } from "@/lib/contract";

export function Footer() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CONTRACT_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <footer className="border-t border-slate-200 bg-alabaster-deep">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-slate-600">
        <div>
          <p className="font-serif text-base text-ink">LegacyVault</p>
          <p className="mt-1 text-xs">Trust-minimized digital estate &amp; succession protocol on GenLayer.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={copy}
            title="Copy contract address"
            className="rounded-full border border-slate-300 bg-white px-3 py-1 font-mono text-xs text-slate-700 hover:bg-slate-50"
          >
            {copied ? "Copied" : `${CONTRACT_ADDRESS.slice(0, 8)}…${CONTRACT_ADDRESS.slice(-6)}`}
          </button>
          <a className="underline" href={explorerAddress(CONTRACT_ADDRESS)} target="_blank" rel="noreferrer">Contract on explorer</a>
          <a className="underline" href={NETWORK.explorerUrl} target="_blank" rel="noreferrer">{NETWORK.name} (chain {NETWORK.chainId})</a>
        </div>
      </div>
    </footer>
  );
}
