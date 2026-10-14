"use client";

import { useState } from "react";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { OwnerHeartbeat } from "@/components/OwnerHeartbeat";
import { ProtocolExplainer } from "@/components/ProtocolExplainer";
import { ProtocolProvider, useProtocol } from "@/components/ProtocolProvider";
import { RegistryInspector } from "@/components/RegistryInspector";
import { SuccessionDesk } from "@/components/SuccessionDesk";
import { SyncAlert } from "@/components/SyncAlert";
import { VaultCreator } from "@/components/VaultCreator";
import { WalletProvider, useWallet } from "@/components/WalletProvider";
import { formatGen } from "@/lib/units";

const TABS = [
  { id: "create", label: "Create vault" },
  { id: "owner", label: "Owner desk" },
  { id: "succession", label: "Succession desk" },
  { id: "registries", label: "Registries" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-card">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 font-serif text-2xl text-ink">{value}</p>
    </div>
  );
}

function Workspace() {
  const { account } = useWallet();
  const { overview, status } = useProtocol();
  const [tab, setTab] = useState<TabId>("create");

  // Unknown is "—", never 0: a failed read must not look like an empty protocol.
  const known = overview !== null;
  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pb-6 pt-12">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-forest-700">GenLayer Intelligent Contract</p>
        <h1 className="mt-2 max-w-3xl font-serif text-4xl leading-tight text-ink sm:text-5xl">
          Leave an estate that the world has to confirm, and that you can still veto.
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-600">
          Cryptographic inactivity bounds, staked succession claims, three-registry vital-record consensus and a 30-day
          veto-and-slash window, enforced by validators rather than a timer.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <Stat label="Vaults" value={known ? String(overview.vaultCount) : "—"} />
          <Stat label="Value in escrow" value={known ? `${formatGen(overview.escrowed)} GEN` : "—"} />
          <Stat label="Solvency" value={known ? (overview.solvent ? "Fully backed" : "Check balance") : "—"} />
        </div>
        {status === "loading" && <p className="mt-3 text-xs text-slate-500">Reading protocol state…</p>}
      </section>

      <nav className="mx-auto max-w-6xl px-6" aria-label="Workspace">
        <div className="flex gap-1 border-b border-slate-200">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                tab === t.id ? "border-forest-700 text-forest-800" : "border-transparent text-slate-500 hover:text-ink"
              }`}
              aria-current={tab === t.id ? "page" : undefined}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Keyed by wallet address: switching accounts unmounts every panel,
          clearing its form state, vault data and in-flight transaction. */}
      <main key={account ?? "disconnected"} className="mx-auto max-w-6xl px-6 py-8">
        {tab === "create" && <VaultCreator />}
        {tab === "owner" && <OwnerHeartbeat />}
        {tab === "succession" && <SuccessionDesk />}
        {tab === "registries" && <RegistryInspector />}
      </main>
    </>
  );
}

export default function Page() {
  return (
    <WalletProvider>
      <ProtocolProvider>
        <Header />
        <SyncAlert />
        <Workspace />
        <ProtocolExplainer />
        <Footer />
      </ProtocolProvider>
    </WalletProvider>
  );
}
