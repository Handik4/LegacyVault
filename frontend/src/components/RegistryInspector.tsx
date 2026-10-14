"use client";

import { useState } from "react";
import { READ_TIMEOUT_MS, readWithTimeout } from "@/lib/contract";
import { DAY, aggregate, evaluateRecord, type Consensus, type SourceOutcome } from "@/lib/registry";
import { nowSeconds } from "@/lib/time";
import { useProtocol } from "./ProtocolProvider";
import { useAllVaults } from "./useVaults";
import { Badge, Button, Card, Field, SectionTitle, inputCls, short } from "./ui";

interface Probe {
  host: string;
  outcome: SourceOutcome;
}

const STATE_LABEL: Record<SourceOutcome["state"], { tone: "healthy" | "slash" | "neutral" | "veto"; text: string }> = {
  confirmed: { tone: "healthy", text: "Confirmed" },
  no_record: { tone: "slash", text: "No matching record" },
  unreachable: { tone: "veto", text: "Not responding" },
};

const VERDICT_TONE = { VERIFIED_DECEASED: "healthy", NO_RECORD_FOUND: "slash", QUORUM_FAILURE: "veto" } as const;

async function probe(baseUrl: string, commitment: string, ctx: Parameters<typeof evaluateRecord>[1]): Promise<SourceOutcome> {
  const unreachable = (detail: string): SourceOutcome => ({ state: "unreachable", certHash: "", deathEpoch: 0, detail });
  try {
    return await readWithTimeout(async (signal) => {
      const res = await fetch(`${baseUrl}/${commitment}.json`, { signal, cache: "no-store" });
      if (res.status === 404 || res.status === 410) {
        return { state: "no_record", certHash: "", deathEpoch: 0, detail: `HTTP ${res.status}: no record published.` } as SourceOutcome;
      }
      if (!res.ok) return unreachable(`HTTP ${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return unreachable("Body is not valid JSON.");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body) || (body as any).schema !== "legacyvault.vital-record/v1") {
        return unreachable("Registry does not answer in the LegacyVault schema.");
      }
      return evaluateRecord(body, ctx);
    }, READ_TIMEOUT_MS);
  } catch (e) {
    return unreachable((e as Error)?.name === "ReadTimeoutError" ? "Timed out after 6s." : "Network error (CORS or offline).");
  }
}

export function RegistryInspector() {
  const { overview, status } = useProtocol();
  const { vaults } = useAllVaults(true);
  const [selected, setSelected] = useState("");
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Probe[] | null>(null);
  const [consensus, setConsensus] = useState<Consensus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const vault = vaults?.find((v) => String(v.id) === selected) ?? null;
  const commitment = (vault ? vault.commitment : manual.trim().toLowerCase());
  const commitmentOk = /^[0-9a-f]{64}$/.test(commitment);

  const run = async () => {
    if (!overview || !commitmentOk) return;
    setBusy(true);
    setError(null);
    const ctx = {
      commitment,
      creationDay: vault ? Math.floor(vault.createdAt / DAY) * DAY : 0,
      now: nowSeconds(),
      lastHeartbeat: vault ? vault.lastHeartbeat : 0,
    };
    const outcomes = await Promise.all(overview.registries.map((r) => probe(r.baseUrl, commitment, ctx)));
    setResults(overview.registries.map((r, i) => ({ host: r.host, outcome: outcomes[i] })));
    setConsensus(aggregate(outcomes));
    setBusy(false);
  };

  return (
    <div>
      <SectionTitle eyebrow="Registry inspector" title="Three independent sources, quorum of two, unanimity among responders">
        Registry endpoints are fixed in the contract and rotate only through a 7-day timelock. Claimants never supply a URL.
      </SectionTitle>

      <div className="grid gap-4 md:grid-cols-3">
        {status !== "ready" && !overview
          ? [0, 1, 2].map((i) => (
              <Card key={i} className="p-4">
                <p className="text-xs text-slate-500">Source {i + 1}</p>
                <p className="mt-1 font-mono text-sm text-slate-400">—</p>
                <p className="mt-2 text-xs text-slate-500">Awaiting network read.</p>
              </Card>
            ))
          : overview?.registries.map((r, i) => {
              const p = results?.[i];
              const label = p ? STATE_LABEL[p.outcome.state] : null;
              return (
                <Card key={r.index} className="p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500">Source {i + 1}</p>
                    {label && <Badge tone={label.tone}>{label.text}</Badge>}
                  </div>
                  <p className="mt-1 break-all font-mono text-sm text-ink">{r.host}</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{r.baseUrl}</p>
                  {p && <p className="mt-2 text-xs text-slate-600">{p.outcome.detail}</p>}
                  {r.pendingAt > 0 && (
                    <p className="mt-2 rounded bg-veto-50 px-2 py-1 text-xs text-veto-700">
                      Rotation staged to {short(r.pendingUrl, 14)}
                    </p>
                  )}
                </Card>
              );
            })}
      </div>

      <Card className="mt-6 p-5">
        <h3 className="font-serif text-lg text-ink">Preview a lookup</h3>
        <p className="mt-1 text-sm text-slate-600">
          Fetches each registry from your browser and applies the same record rules validators use. The on-chain check is authoritative.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Vault">
            <select className={inputCls} value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Enter a commitment manually…</option>
              {(vaults ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  Vault #{v.id} · {short(v.commitment, 6)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Identity commitment" error={!vault && manual && !commitmentOk ? "Expected 64 hex characters." : null}>
            <input
              className={inputCls + " font-mono text-xs"}
              value={vault ? vault.commitment : manual}
              disabled={!!vault}
              onChange={(e) => setManual(e.target.value)}
              placeholder="64-char hex SHA-256"
            />
          </Field>
        </div>
        <Button className="mt-4" onClick={run} disabled={busy || !commitmentOk || !overview}>
          {busy ? "Querying registries…" : "Query all three sources"}
        </Button>
        {error && <p className="mt-3 text-sm text-crimson-700">{error}</p>}

        {consensus && (
          <div className="mt-5 rounded-lg border border-slate-200 bg-alabaster p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={VERDICT_TONE[consensus.verdict]}>{consensus.verdict}</Badge>
              <span className="text-sm text-slate-700">
                {consensus.sourceCount} of 3 sources responded · quorum needs 2 · responders must all agree
              </span>
            </div>
            <div className="mt-3 flex gap-2" aria-label="Quorum visualizer">
              {results?.map((p, i) => (
                <span
                  key={i}
                  title={p.host}
                  className={`h-3 flex-1 rounded-full ${
                    p.outcome.state === "confirmed" ? "bg-forest-600" : p.outcome.state === "no_record" ? "bg-crimson-600" : "bg-slate-300"
                  }`}
                />
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
