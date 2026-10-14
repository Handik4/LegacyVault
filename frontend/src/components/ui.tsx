"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, explorerTx, writeVault, type WritePhase, type WriteResult } from "@/lib/contract";
import { useWallet } from "./WalletProvider";
import { useProtocol } from "./ProtocolProvider";

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-slate-200 bg-white shadow-card ${className}`}>{children}</section>;
}

export function SectionTitle({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5">
      {eyebrow && <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{eyebrow}</p>}
      <h2 className="mt-1 font-serif text-2xl text-ink">{title}</h2>
      {children && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-600">{children}</p>}
    </div>
  );
}

const TONES = {
  healthy: "border-forest-100 bg-forest-50 text-forest-800",
  veto: "border-veto-100 bg-veto-50 text-veto-700",
  slash: "border-crimson-100 bg-crimson-50 text-crimson-700",
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
} as const;

export function Badge({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function StateBadge({ state, name }: { state: number; name: string }) {
  const tone = state === 0 ? "healthy" : state === 1 || state === 2 ? "veto" : state === 3 ? "neutral" : "slash";
  const label =
    state === 0 ? "Active" : state === 1 ? "Claim awaiting verification" : state === 2 ? "Veto challenge period" : state === 3 ? "Succeeded" : "Revoked";
  return <Badge tone={tone}><span className="h-1.5 w-1.5 rounded-full bg-current" />{label || name}</Badge>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">{label}</span>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <span className="mt-1 block text-xs text-crimson-700">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-forest-600 focus:outline-none focus:ring-2 focus:ring-forest-100 disabled:bg-slate-100";

const BTN = {
  primary: "bg-forest-700 text-white hover:bg-forest-800 disabled:bg-slate-300",
  veto: "bg-veto-600 text-white hover:bg-veto-700 disabled:bg-slate-300",
  slash: "bg-crimson-600 text-white hover:bg-crimson-700 disabled:bg-slate-300",
  ghost: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:text-slate-400",
} as const;

export function Button({
  variant = "primary",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BTN }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${BTN[variant]} ${className}`}
    />
  );
}

export function Meter({ ratio, tone }: { ratio: number; tone: "healthy" | "veto" | "slash" }) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  const bar = tone === "healthy" ? "bg-forest-600" : tone === "veto" ? "bg-veto-600" : "bg-crimson-600";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${bar} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export const short = (a: string, n = 6) => (a.length > 2 * n + 2 ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : a);

// ---- transaction runner -----------------------------------------------------------
export interface TxRequest {
  functionName: string;
  args: unknown[];
  value?: bigint;
}

export interface TxState {
  busy: boolean;
  phase: WritePhase | null;
  error: string | null;
  result: WriteResult | null;
  run: (req: TxRequest) => Promise<WriteResult | null>;
  reset: () => void;
}

/**
 * Runs writes for the connected account. The AbortController is tied to the
 * component's lifetime: panels are keyed by account, so switching accounts
 * unmounts them and any in-flight write's outcome is discarded, never shown
 * against the new account.
 */
export function useTx(onSuccess?: () => void): TxState {
  const { account, provider, chainOk } = useWallet();
  const { refresh } = useProtocol();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<WritePhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const acRef = useRef<AbortController | null>(null);

  useEffect(() => () => acRef.current?.abort(), []);

  const run = useCallback(
    async (req: TxRequest) => {
      if (!account || !provider) {
        setError("Connect a wallet first.");
        return null;
      }
      if (!chainOk) {
        setError("Wallet is on the wrong network. Switch to GenLayer Studio Next (chain 61997).");
        return null;
      }
      acRef.current?.abort();
      const ac = new AbortController();
      acRef.current = ac;
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const res = await writeVault({
          account,
          provider,
          functionName: req.functionName,
          args: req.args,
          value: req.value,
          signal: ac.signal,
          onPhase: (p) => !ac.signal.aborted && setPhase(p),
        });
        if (ac.signal.aborted) return null;
        setResult(res);
        refresh();
        onSuccess?.();
        return res;
      } catch (e) {
        if ((e as Error)?.name === "AbortError" || ac.signal.aborted) return null;
        setError(describeError(e));
        return null;
      } finally {
        if (!ac.signal.aborted) {
          setBusy(false);
          setPhase(null);
        }
      }
    },
    [account, provider, chainOk, refresh, onSuccess],
  );

  const reset = useCallback(() => {
    setError(null);
    setResult(null);
  }, []);

  return { busy, phase, error, result, run, reset };
}

const PHASE_LABEL: Record<WritePhase, string> = {
  estimating: "Quoting network fee…",
  signing: "Waiting for wallet signature…",
  confirming: "Validators reaching consensus…",
};

export function TxStatus({ tx }: { tx: TxState }) {
  if (tx.busy && tx.phase) {
    return <p className="mt-3 text-sm text-slate-600" role="status">{PHASE_LABEL[tx.phase]}</p>;
  }
  if (tx.error) {
    return (
      <p className="mt-3 rounded-lg border border-crimson-100 bg-crimson-50 px-3 py-2 text-sm text-crimson-700" role="alert">
        {tx.error}
      </p>
    );
  }
  if (tx.result) {
    return (
      <p className="mt-3 rounded-lg border border-forest-100 bg-forest-50 px-3 py-2 text-sm text-forest-800" role="status">
        Accepted by validator majority.{" "}
        <a className="underline" href={explorerTx(tx.result.hash)} target="_blank" rel="noreferrer">
          View transaction
        </a>
      </p>
    );
  }
  return null;
}
