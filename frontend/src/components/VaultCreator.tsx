"use client";

import { useEffect, useMemo, useState } from "react";
import { BPS_TOTAL, MAX_HEIRS, bpsToPercent, checkShares, evenShares, splitShares } from "@/lib/bps";
import { identityCommitment, identityPreimage } from "@/lib/identity";
import { MIN_DEPOSIT_WEI, formatGen, parseGenAmount, parseWholeNumber } from "@/lib/units";
import { useWallet } from "./WalletProvider";
import { Button, Card, Field, SectionTitle, TxStatus, inputCls, useTx } from "./ui";

interface HeirRow {
  address: string;
  bps: string;
  note: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

export function VaultCreator() {
  const { account, connect } = useWallet();
  const tx = useTx();

  const [fullName, setFullName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [days, setDays] = useState("180");
  const [deposit, setDeposit] = useState("");
  const [executor, setExecutor] = useState("");
  const [heirs, setHeirs] = useState<HeirRow[]>([
    { address: "", bps: "6000", note: "" },
    { address: "", bps: "4000", note: "" },
  ]);

  // Identity commitment is computed in the browser; PII never leaves it.
  const [commitment, setCommitment] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const touched = fullName || birthDate || jurisdiction;
    if (!touched) {
      setCommitment(null);
      setIdentityError(null);
      return;
    }
    const pre = identityPreimage({ fullName, birthDate, jurisdictionId: jurisdiction });
    if (!pre.ok) {
      setCommitment(null);
      setIdentityError(pre.error);
      return;
    }
    identityCommitment({ fullName, birthDate, jurisdictionId: jurisdiction }).then((r) => {
      if (!live) return;
      if (r.ok) {
        setCommitment(r.commitment);
        setIdentityError(null);
      }
    });
    return () => {
      live = false;
    };
  }, [fullName, birthDate, jurisdiction]);

  const daysParsed = parseWholeNumber(days, 90, 3650);
  const depositParsed = deposit === "" ? null : parseGenAmount(deposit, { min: MIN_DEPOSIT_WEI });

  const bpsNums = heirs.map((h) => (/^[0-9]{1,5}$/.test(h.bps.trim()) ? Number(h.bps.trim()) : NaN));
  const shareCheck = checkShares(bpsNums.map((n) => (Number.isNaN(n) ? -1 : n)));
  const heirErrors = useMemo(() => {
    const seen = new Set<string>();
    return heirs.map((h) => {
      const a = h.address.trim();
      if (!ADDRESS.test(a)) return "Enter a 0x… address (42 characters).";
      if (ZERO.test(a)) return "The zero address is not allowed.";
      if (account && a.toLowerCase() === account) return "The owner cannot be a beneficiary.";
      if (seen.has(a.toLowerCase())) return "Duplicate beneficiary.";
      seen.add(a.toLowerCase());
      if (h.note.length > 512) return "Note reference exceeds 512 characters.";
      return null;
    });
  }, [heirs, account]);
  const executorError =
    executor.trim() === ""
      ? null
      : !ADDRESS.test(executor.trim()) || ZERO.test(executor.trim())
        ? "Enter a valid 0x… address or leave blank."
        : account && executor.trim().toLowerCase() === account
          ? "The owner cannot be the executor."
          : null;

  const principal = depositParsed && depositParsed.ok ? depositParsed.wei : null;
  const preview =
    principal !== null && shareCheck.ok ? splitShares(principal, bpsNums) : null;

  const valid =
    commitment !== null &&
    daysParsed.ok &&
    depositParsed?.ok === true &&
    shareCheck.ok &&
    heirErrors.every((e) => e === null) &&
    executorError === null;

  const setHeir = (i: number, patch: Partial<HeirRow>) =>
    setHeirs((hs) => hs.map((h, j) => (j === i ? { ...h, ...patch } : h)));

  const evenly = () => {
    const sh = evenShares(heirs.length);
    setHeirs((hs) => hs.map((h, i) => ({ ...h, bps: String(sh[i]) })));
  };

  const submit = async () => {
    if (!valid || !daysParsed.ok || !depositParsed?.ok || commitment === null) return;
    await tx.run({
      functionName: "create_vault",
      args: [
        commitment,
        daysParsed.value,
        heirs.map((h) => h.address.trim()),
        bpsNums,
        heirs.map((h) => h.note.trim()),
        executor.trim(),
      ],
      value: depositParsed.wei,
    });
  };

  const total = bpsNums.reduce((a, b) => a + (Number.isNaN(b) ? 0 : b), 0);

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="p-6 lg:col-span-3">
        <SectionTitle eyebrow="Create estate vault" title="Commit an identity, fund the estate, name the heirs">
          Name and birth date are hashed in your browser. Only the 64-character commitment is written on-chain.
        </SectionTitle>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Legal full name">
            <input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Ada Lovelace" autoComplete="off" />
          </Field>
          <Field label="Birth date">
            <input className={inputCls} type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
          </Field>
          <Field label="Jurisdiction id">
            <input className={inputCls} value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="GB-LND" autoComplete="off" />
          </Field>
        </div>

        <div className="mt-4 rounded-lg border border-slate-200 bg-alabaster px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Identity commitment (SHA-256)</p>
          <p className="mt-1 break-all font-mono text-xs text-ink" data-testid="commitment">
            {commitment ?? (identityError ? identityError : "Enter name, birth date and jurisdiction.")}
          </p>
          <p className="mt-1 text-xs text-slate-500">Immutable once the vault is created. Registries look up records by this value.</p>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field
            label="Deposit (GEN)"
            hint={`Minimum ${formatGen(MIN_DEPOSIT_WEI)} GEN. Plain decimals only.`}
            error={depositParsed && !depositParsed.ok ? depositParsed.error : null}
          >
            <input className={inputCls} inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="1.0" autoComplete="off" />
          </Field>
          <Field
            label="Inactivity window (days)"
            hint="90 to 3650. A heartbeat resets this clock."
            error={!daysParsed.ok ? daysParsed.error : null}
          >
            <input className={inputCls} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>

        <div className="mt-6">
          <div className="flex items-end justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600">Beneficiaries</h3>
            <div className="flex gap-2">
              <button type="button" onClick={evenly} className="text-xs font-medium text-forest-700 underline">Split evenly</button>
              {heirs.length < MAX_HEIRS && (
                <button type="button" onClick={() => setHeirs((h) => [...h, { address: "", bps: "", note: "" }])} className="text-xs font-medium text-forest-700 underline">
                  Add beneficiary
                </button>
              )}
            </div>
          </div>
          <div className="mt-3 space-y-3">
            {heirs.map((h, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-3">
                <div className="grid gap-3 sm:grid-cols-6">
                  <div className="sm:col-span-4">
                    <input
                      aria-label={`Beneficiary ${i + 1} address`}
                      className={inputCls + " font-mono text-xs"}
                      value={h.address}
                      onChange={(e) => setHeir(i, { address: e.target.value })}
                      placeholder={i === 0 ? "0x… primary beneficiary (receives rounding remainder)" : "0x…"}
                      autoComplete="off"
                    />
                  </div>
                  <div className="sm:col-span-2 flex gap-2">
                    <input
                      aria-label={`Beneficiary ${i + 1} share in bps`}
                      className={inputCls}
                      inputMode="numeric"
                      value={h.bps}
                      onChange={(e) => setHeir(i, { bps: e.target.value })}
                      placeholder="bps"
                    />
                    {heirs.length > 1 && (
                      <button type="button" aria-label={`Remove beneficiary ${i + 1}`} onClick={() => setHeirs((hs) => hs.filter((_, j) => j !== i))} className="px-2 text-slate-400 hover:text-crimson-700">×</button>
                    )}
                  </div>
                </div>
                <input
                  aria-label={`Beneficiary ${i + 1} encrypted note reference`}
                  className={inputCls + " mt-2 text-xs"}
                  value={h.note}
                  onChange={(e) => setHeir(i, { note: e.target.value })}
                  placeholder="Encrypted key-shard / note reference (ciphertext or pointer, e.g. ipfs://…)"
                  autoComplete="off"
                />
                <div className="mt-1 flex justify-between text-xs">
                  <span className={heirErrors[i] ? "text-crimson-700" : "text-slate-500"}>
                    {heirErrors[i] ?? (Number.isNaN(bpsNums[i]) ? "" : bpsToPercent(bpsNums[i]))}
                  </span>
                  {preview && <span className="font-mono text-slate-600">{formatGen(preview[i], 6)} GEN</span>}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3">
            <div className="flex items-center justify-between text-xs">
              <span className={shareCheck.ok ? "font-medium text-forest-700" : "font-medium text-crimson-700"}>
                {total} / {BPS_TOTAL} bps
              </span>
              {!shareCheck.ok && <span className="text-crimson-700">{shareCheck.error}</span>}
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full ${shareCheck.ok ? "bg-forest-600" : total > BPS_TOTAL ? "bg-crimson-600" : "bg-veto-600"}`}
                style={{ width: `${Math.min(100, (total / BPS_TOTAL) * 100)}%` }}
              />
            </div>
          </div>
        </div>

        <div className="mt-6">
          <Field label="Executor (optional)" hint="May open a claim with a bond but receives no allocation." error={executorError}>
            <input className={inputCls + " font-mono text-xs"} value={executor} onChange={(e) => setExecutor(e.target.value)} placeholder="0x… or leave blank" autoComplete="off" />
          </Field>
        </div>

        <div className="mt-6 flex items-center gap-3">
          {account ? (
            <Button onClick={submit} disabled={!valid || tx.busy}>
              {tx.busy ? "Working…" : "Create vault"}
            </Button>
          ) : (
            <Button onClick={connect}>Connect wallet to create</Button>
          )}
          {!valid && account && <span className="text-xs text-slate-500">Complete every field to enable.</span>}
        </div>
        <TxStatus tx={tx} />
      </Card>

      <Card className="p-6 lg:col-span-2">
        <h3 className="font-serif text-lg text-ink">What gets locked in</h3>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed text-slate-600">
          <li><strong className="text-ink">Identity.</strong> The commitment cannot be changed. A different person cannot be substituted later.</li>
          <li><strong className="text-ink">Inactivity.</strong> Heirs cannot even open a claim until the window elapses without a heartbeat.</li>
          <li><strong className="text-ink">Allocation.</strong> Shares total exactly 10,000 bps. Rounding remainder goes to the first beneficiary, so no wei is stranded.</li>
          <li><strong className="text-ink">Control.</strong> You can heartbeat, veto a claim (taking the claimant&apos;s whole bond) or revoke the vault until succession is finalized.</li>
        </ul>
        <p className="mt-4 rounded-lg bg-alabaster p-3 text-xs leading-relaxed text-slate-600">
          Note references are stored on a public chain. Provide ciphertext or a pointer to ciphertext, never plaintext secrets.
        </p>
      </Card>
    </div>
  );
}
