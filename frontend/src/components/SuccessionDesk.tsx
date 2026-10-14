"use client";

import { useState } from "react";
import { bpsToPercent } from "@/lib/bps";
import { formatCountdown, formatDate } from "@/lib/time";
import { formatGen } from "@/lib/units";
import { STATE, sameAddress, type VaultView } from "@/lib/types";
import { useAccountVaults } from "./useVaults";
import { useWallet } from "./WalletProvider";
import { Badge, Button, Card, Meter, SectionTitle, StateBadge, TxStatus, short, useNow, useTx } from "./ui";

const VERDICT_TEXT: Record<string, { tone: "healthy" | "veto" | "slash"; text: string }> = {
  "1": { tone: "healthy", text: "VERIFIED_DECEASED: 30-day veto window is now open." },
  "0": { tone: "slash", text: "NO_RECORD_FOUND: the registries did not corroborate a death. Your bond joined the estate." },
  "2": { tone: "veto", text: "QUORUM_FAILURE: fewer than 2 registries answered. Nothing was slashed; retry shortly." },
};

function Desk({ v, account }: { v: VaultView; account: string }) {
  const now = useNow();
  const tx = useTx();
  const [verdict, setVerdict] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const isHeir = v.heirs.some((h) => sameAddress(h.address, account));
  const isExecutor = sameAddress(v.executor, account);
  const isClaimant = sameAddress(v.claimant, account);
  const myHeir = v.heirs.find((h) => sameAddress(h.address, account));
  const eligibleIn = v.claimableAt - now;
  const vetoLeft = v.vetoUntil - now;
  const vetoTotal = 30 * 86400;

  const runVerify = async () => {
    const r = await tx.run({ functionName: "verify_claim", args: [v.id] });
    if (r?.returnValue != null) setVerdict(String(r.returnValue));
  };
  const runClaim = async () => {
    const r = await tx.run({ functionName: "claim_inheritance", args: [v.id] });
    if (r?.returnValue != null) setNote(String(r.returnValue));
  };

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">
            Vault #{v.id} · {isHeir ? "beneficiary" : isExecutor ? "executor" : "claimant"}
          </p>
          <p className="font-serif text-2xl text-ink">{formatGen(v.principal, 6)} GEN</p>
        </div>
        <StateBadge state={v.state} name={v.stateName} />
      </div>

      {v.state === STATE.ACTIVE && (
        <div className="mt-4">
          {eligibleIn > 0 ? (
            <p className="text-sm text-slate-600">
              The owner is within their inactivity window. A claim can open in{" "}
              <span className="font-mono text-ink">{formatCountdown(eligibleIn)}</span> ({formatDate(v.claimableAt)}) unless they send a heartbeat.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                The inactivity window has elapsed. Opening a claim stakes a bond of{" "}
                <strong className="text-ink">{formatGen(v.requiredBond, 6)} GEN</strong> (10% of principal, with a fixed floor).
                A living owner can veto and keep it.
              </p>
              {(isHeir || isExecutor) && (
                <Button className="mt-3" disabled={tx.busy} onClick={() => tx.run({ functionName: "initiate_claim", args: [v.id], value: v.requiredBond })}>
                  Post {formatGen(v.requiredBond, 6)} GEN bond &amp; initiate claim
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {v.state === STATE.CLAIM_INITIATED && (
        <div className="mt-4 rounded-lg border border-veto-100 bg-veto-50 p-4">
          <p className="text-sm text-veto-700">
            Claim open by <span className="font-mono">{short(v.claimant, 8)}</span> with a {formatGen(v.claimBond, 6)} GEN bond.
            Validators will query three independent civil registries; two must answer and all responders must agree.
          </p>
          {isClaimant ? (
            <div className="mt-3 flex flex-wrap gap-3">
              <Button variant="veto" disabled={tx.busy} onClick={runVerify}>Run 3-source registry check</Button>
              <Button variant="ghost" disabled={tx.busy} onClick={() => tx.run({ functionName: "withdraw_claim", args: [v.id] })}>
                Withdraw claim &amp; reclaim bond
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-600">Only the claimant can trigger verification.</p>
          )}
          {v.verifyAttempts > 0 && <p className="mt-2 text-xs text-slate-600">Verification attempts so far: {v.verifyAttempts}</p>}
        </div>
      )}

      {v.state === STATE.VETO && (
        <div className="mt-4 rounded-lg border border-veto-100 bg-veto-50 p-4">
          <div className="flex items-center justify-between">
            <Badge tone="veto">Veto challenge period</Badge>
            <span className="font-mono text-lg text-veto-700">{vetoLeft > 0 ? formatCountdown(vetoLeft) : "elapsed"}</span>
          </div>
          <div className="mt-3"><Meter ratio={1 - Math.max(0, vetoLeft) / vetoTotal} tone="veto" /></div>
          <p className="mt-2 text-xs text-veto-700">
            Registries certify a death on {formatDate(v.certEpoch)}. Until finalization the owner can still veto and take the bond.
          </p>
          <Button className="mt-3" variant="primary" disabled={tx.busy || vetoLeft > 0} onClick={() => tx.run({ functionName: "finalize_succession", args: [v.id] })}>
            {vetoLeft > 0 ? "Finalize after veto window" : "Finalize succession"}
          </Button>
        </div>
      )}

      {v.state === STATE.SUCCEEDED && (
        <div className="mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="py-1 font-semibold">Beneficiary</th><th className="py-1 font-semibold">Share</th><th className="py-1 text-right font-semibold">Allocation</th>
              </tr>
            </thead>
            <tbody>
              {v.heirs.map((h) => (
                <tr key={h.address} className="border-t border-slate-100">
                  <td className="py-2 font-mono text-xs">{short(h.address, 8)}{sameAddress(h.address, account) ? " (you)" : ""}</td>
                  <td className="py-2">{bpsToPercent(h.bps)}</td>
                  <td className="py-2 text-right">{formatGen(h.amount, 6)} GEN {h.claimed && <span className="text-xs text-slate-500">· claimed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {myHeir && !myHeir.claimed && (
            <Button className="mt-3" disabled={tx.busy} onClick={runClaim}>Claim my allocation &amp; key-shard reference</Button>
          )}
          {myHeir && (myHeir.noteRef || note) && (
            <p className="mt-3 rounded-lg bg-forest-50 p-3 text-sm text-forest-800">
              Your key-shard reference: <span className="break-all font-mono">{myHeir.noteRef || note}</span>
            </p>
          )}
          {myHeir && !myHeir.noteRef && !note && myHeir.claimed && (
            <p className="mt-3 text-xs text-slate-600">No note reference was registered for your share.</p>
          )}
        </div>
      )}

      {v.state === STATE.REVOKED && <p className="mt-4 text-sm text-slate-600">The owner revoked this vault.</p>}

      {verdict !== null && VERDICT_TEXT[verdict] && (
        <p className={`mt-3 rounded-lg border px-3 py-2 text-sm ${VERDICT_TEXT[verdict].tone === "healthy" ? "border-forest-100 bg-forest-50 text-forest-800" : VERDICT_TEXT[verdict].tone === "veto" ? "border-veto-100 bg-veto-50 text-veto-700" : "border-crimson-100 bg-crimson-50 text-crimson-700"}`}>
          {VERDICT_TEXT[verdict].text}
        </p>
      )}
      <TxStatus tx={tx} />
    </Card>
  );
}

export function SuccessionDesk() {
  const { account, connect } = useWallet();
  const { vaults, status } = useAccountVaults(account);

  if (!account) {
    return (
      <Card className="p-8 text-center">
        <p className="font-serif text-xl text-ink">Connect a beneficiary wallet</p>
        <p className="mt-2 text-sm text-slate-600">Vaults naming your address as beneficiary or executor appear here.</p>
        <Button className="mt-4" onClick={connect}>Connect wallet</Button>
      </Card>
    );
  }
  if (vaults === null) {
    return (
      <Card className="p-8 text-center text-sm text-slate-600">
        {status === "syncing" ? "Succession state unavailable while the network read syncs." : "Loading vaults…"}
      </Card>
    );
  }
  const mine = vaults.filter(
    (v) =>
      v.heirs.some((h) => sameAddress(h.address, account)) ||
      sameAddress(v.executor, account) ||
      sameAddress(v.claimant, account),
  );
  return (
    <div>
      <SectionTitle eyebrow="Succession desk" title="Stake a bond, corroborate, wait out the veto window">
        A claim needs the inactivity window, a bond, three-registry corroboration and a 30-day veto window. Funds are pulled individually by each heir.
      </SectionTitle>
      {mine.length === 0 ? (
        <Card className="p-8 text-center text-sm text-slate-600">No vault names {short(account, 6)} as beneficiary or executor.</Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {mine.map((v) => <Desk key={v.id} v={v} account={account} />)}
        </div>
      )}
    </div>
  );
}
