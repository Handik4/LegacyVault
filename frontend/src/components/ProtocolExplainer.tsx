const STEPS = [
  {
    n: "01",
    title: "Commit",
    body: "Owner locks GEN against a SHA-256 identity commitment and a 1-5 heir table totalling exactly 10,000 bps. The commitment is immutable.",
  },
  {
    n: "02",
    title: "Go quiet, then claim",
    body: "No claim is possible until the inactivity window (90+ days) passes without a heartbeat. An heir then stakes a bond of at least 10% of the vault.",
  },
  {
    n: "03",
    title: "Corroborate",
    body: "Validators query three independent civil registries bound in the contract. Two must answer and every responder must confirm the same certificate.",
  },
  {
    n: "04",
    title: "Veto window, then pull",
    body: "A verified death opens a 30-day veto. A living owner cancels and takes the bond. Otherwise each heir pulls their exact share, remainder to the primary.",
  },
];

export function ProtocolExplainer() {
  return (
    <section aria-labelledby="how" className="mx-auto max-w-6xl px-6 py-14">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Architecture</p>
      <h2 id="how" className="mt-1 font-serif text-3xl text-ink">An estate that cannot be drained by a clock alone</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
        A plain dead-man&apos;s switch releases funds when you forget to ping. LegacyVault also asks the world whether you are actually gone, then gives you a month to say otherwise.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => (
          <div key={s.n} className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
            <p className="font-mono text-xs text-forest-700">{s.n}</p>
            <h3 className="mt-2 font-serif text-lg text-ink">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
