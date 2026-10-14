"use client";

import { useState } from "react";
import { formatGen } from "@/lib/units";
import { formatCountdown, formatDate } from "@/lib/time";
import { STATE, sameAddress, type VaultView } from "@/lib/types";
import { PartialLoadAlert } from "./PartialLoadAlert";
import { useAccountVaults } from "./useVaults";
import { useWallet } from "./WalletProvider";
import { Badge, Button, Card, Meter, SectionTitle, StateBadge, TxStatus, short, useNow, useTx } from "./ui";

function OwnerVault({ v }: { v: VaultView }) {
  const now = useNow();
  const tx = useTx();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const open = v.state === STATE.ACTIVE || v.state === STATE.CLAIM_INITIATED || v.state === STATE.VETO;
  const hasClaim = v.state === STATE.CLAIM_INITIATED || v.state === STATE.VETO;
  const elapsed = Math.max(0, now - v.lastHeartbeat);
  const ratio = v.threshold > 0 ? elapsed / v.threshold : 0;
  const tone = ratio < 0.7 ? "healthy" : ratio < 1 ? "veto" : "slash";
  const vetoLeft = v.vetoUntil - now;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">Vault #{v.id}</p>
          <p className="font-serif text-2xl text-ink">{formatGen(v.principal, 6)} GEN</p>
          <p className="mt-1 break-all font-mono text-[11px] text-slate-500">commitment {short(v.commitment, 10)}</p>
        </div>
        <StateBadge state={v.state} name={v.stateName} />
      </div>

      {v.state === STATE.ACTIVE && (
        <div className="mt-4">
          <div className="flex justify-between text-xs text-slate-600">
            <span>Last heartbeat {formatDate(v.lastHeartbeat)}</span>
            <span>
              {ratio < 1 ? `Claims open in ${formatCountdown(v.claimableAt - now)}` : "Inactivity window elapsed: heirs may open a claim"}
            </span>
          </div>
          <div className="mt-1.5"><Meter ratio={ratio} tone={tone} /></div>
        </div>
      )}

      {hasClaim && (
        <div className="mt-4 rounded-lg border border-veto-100 bg-veto-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge tone="veto">Active succession claim</Badge>
            {v.state === STATE.VETO && (
              <span className="font-mono text-sm text-veto-700">
                {vetoLeft > 0 ? `${formatCountdown(vetoLeft)} left to veto` : "Veto window elapsed; still vetoable until finalized"}
              </span>
            )}
          </div>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-slate-500">Claimant</dt><dd className="font-mono text-xs">{short(v.claimant, 8)}</dd></div>
            <div><dt className="text-xs text-slate-500">Bond at risk</dt><dd>{formatGen(v.claimBond, 6)} GEN</dd></div>
            {v.state === STATE.VETO && (
              <div><dt className="text-xs text-slate-500">Registry-certified date of death</dt><dd>{formatDate(v.certEpoch)}</dd></div>
            )}
          </dl>
          <p className="mt-3 text-xs text-veto-700">
            You are alive: veto now to cancel the claim, reset your clock and take the claimant&apos;s entire bond.
          </p>
          <Button variant="slash" className="mt-3" disabled={tx.busy} onClick={() => tx.run({ functionName: "veto_claim", args: [v.id] })}>
            Veto &amp; slash bond
          </Button>
        </div>
      )}

      {open && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button disabled={tx.busy} onClick={() => tx.run({ functionName: "heartbeat", args: [v.id] })}>
            Send heartbeat
          </Button>
          {!confirmRevoke ? (
            <Button variant="ghost" disabled={tx.busy} onClick={() => setConfirmRevoke(true)}>Revoke vault</Button>
          ) : (
            <span className="flex items-center gap-2">
              <span className="text-xs text-crimson-700">Withdraws {formatGen(v.principal, 6)} GEN and ends the vault.</span>
              <Button variant="slash" disabled={tx.busy} onClick={() => { setConfirmRevoke(false); void tx.run({ functionName: "revoke_vault", args: [v.id] }); }}>
                Confirm revoke
              </Button>
              <button className="text-xs underline" onClick={() => setConfirmRevoke(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}
      {v.state === STATE.SUCCEEDED && <p className="mt-4 text-sm text-slate-600">Succession finalized. Heirs are pulling their allocations.</p>}
      {v.state === STATE.REVOKED && <p className="mt-4 text-sm text-slate-600">You withdrew this estate.</p>}
      <TxStatus tx={tx} />
    </Card>
  );
}

export function OwnerHeartbeat() {
  const { account, connect } = useWallet();
  const view = useAccountVaults(account);
  const { vaults, status } = view;

  if (!account) {
    return (
      <Card className="p-8 text-center">
        <p className="font-serif text-xl text-ink">Connect the owner wallet</p>
        <p className="mt-2 text-sm text-slate-600">Your vaults, heartbeat and veto controls appear here.</p>
        <Button className="mt-4" onClick={connect}>Connect wallet</Button>
      </Card>
    );
  }
  if (vaults === null) {
    return (
      <Card className="p-8 text-center text-sm text-slate-600">
        {status === "syncing" ? (
          <>
            Vault state unavailable while the network read syncs.
            <Button variant="ghost" className="ml-3" onClick={view.retry}>Retry</Button>
          </>
        ) : (
          "Loading your vaults…"
        )}
      </Card>
    );
  }
  const mine = vaults.filter((v) => sameAddress(v.owner, account));
  return (
    <div>
      <SectionTitle eyebrow="Owner control center" title="Prove you are alive, veto false claims">
        A heartbeat resets the inactivity clock. A veto or heartbeat during a claim cancels it and confiscates the claimant&apos;s bond.
      </SectionTitle>
      <PartialLoadAlert view={view} />
      {status === "loading" && <p className="mb-3 text-xs text-slate-500">Loading your vaults…</p>}
      {mine.length === 0 ? (
        // Only claim "none" when every read succeeded; otherwise the alert above
        // is the truthful statement and this card would be a false one.
        status === "ready" ? (
          <Card className="p-8 text-center text-sm text-slate-600">No vaults owned by {short(account, 6)}. Create one to begin.</Card>
        ) : null
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {mine.map((v) => <OwnerVault key={v.id} v={v} />)}
        </div>
      )}
    </div>
  );
}
