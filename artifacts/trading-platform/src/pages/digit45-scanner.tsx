import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Activity, AlertTriangle, ArrowRight, Loader2, ScanSearch, ShieldCheck, Workflow } from "lucide-react";
import { useGetSettings } from "@workspace/api-client-react";
import { loadStrategyIntoBotBuilder } from "@/lib/bot-builder-frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Candidate = {
  symbol: string;
  displayName: string;
  samples: number;
  asOf: number;
  digit4: { count: number; rate: number; upper: number };
  digit5: { count: number; rate: number; upper: number };
  combined: { count: number; rate: number; upper: number };
  recentCombinedRate: number;
  eligible: boolean;
  reason: string;
};
type Scan = {
  scanId: string | null;
  expiresAt: number | null;
  markets: Candidate[];
  eligible: number;
  marketsChecked: number;
  dataSource: "broker-live" | "unavailable";
  reason: string;
};
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function Field({ label, hint, value, change, min, max, step = 1 }: {
  label: string; hint: string; value: number; change: (n: number) => void;
  min: number; max: number; step?: number;
}) {
  return <label className="block space-y-1.5">
    <span className="text-xs font-semibold text-foreground">{label}</span>
    <Input type="number" min={min} max={max} step={step} value={value}
      onChange={e => change(Number(e.target.value))}
      className="h-9 bg-black/20 font-mono" />
    <span className="block text-[11px] leading-4 text-muted-foreground">{hint}</span>
  </label>;
}

export default function Digit45Scanner() {
  const [, navigate] = useLocation();
  const { data: settings } = useGetSettings();
  const [scan, setScan] = useState<Scan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [form, setForm] = useState({ stake: 1, takeProfit: 10, stopLoss: 30, maxRecoverySteps: 3, maxStake: 20 });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const expiresIn = scan?.expiresAt ? Math.max(0, Math.ceil((scan.expiresAt - now) / 1000)) : 0;
  const markup = Number((settings as any)?.botRecoveryMarkup ?? 10);
  const accountMax = Number((settings as any)?.maxTradeStake ?? 500);
  useEffect(() => {
    // Account settings can load after the page. Never offer an initial max
    // stake above the account's configured per-trade limit.
    if (Number.isFinite(accountMax) && accountMax >= 0.35) {
      setForm(current => current.maxStake > accountMax
        ? { ...current, maxStake: accountMax } : current);
    }
  }, [accountMax]);
  const recoveryExample = Math.ceil((2 * (1 + markup / 100) / (2.43 - 2)) * 100 - 1e-9) / 100;

  async function runScan() {
    if (scanning) return;
    setScan(null);
    setScanning(true);
    try {
      const response = await fetch("/api/scanners/digit-45/scan", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Scan failed");
      setScan(data as Scan);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to scan markets");
    } finally { setScanning(false); }
  }

  async function createDbot(candidate: Candidate) {
    if (!scan?.scanId || !candidate.eligible || expiresIn === 0 || creating) return;
    setCreating(candidate.symbol);
    try {
      const response = await fetch("/api/scanners/digit-45/dbot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scanId: scan.scanId, symbol: candidate.symbol, ...form }),
      });
      const data = await response.json();
      if (!response.ok || !data?.xml) throw new Error(data.error ?? "DBot generation failed");
      const loaded = loadStrategyIntoBotBuilder({ name: data.name, xml: data.xml, symbol: candidate.symbol });
      toast.info(`Loading the two-leg strategy for ${candidate.displayName} in Bot Builder…`);
      navigate("/bot-builder");
      if (await loaded) {
        toast.success("DBot blocks are ready. Review both pairs and risk limits, then press Run in Bot Builder when you choose.");
      } else {
        toast.error("Bot Builder did not confirm the XML load. No trades were started; re-scan and try again.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create DBot");
    } finally { setCreating(null); }
  }

  return <div className="mx-auto max-w-6xl space-y-6 p-4 pb-12 md:p-7">
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400"><ScanSearch size={15} /> Market intelligence · scanner only</div>
      <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Digit 4 &amp; 5 Weakness Scanner</h1>
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">Measure verified Deriv digits, choose a market, then create an editable strategy in Bot Builder. <strong className="text-foreground">Scanning and creating blocks never place a trade.</strong> The builder trades only after you press Run.</p>
    </div>

    <Card className="border-cyan-500/20 bg-cyan-500/[0.04]"><CardContent className="grid gap-4 p-4 text-sm md:grid-cols-2 md:p-5">
      <div><div className="mb-2 flex items-center gap-2 font-semibold text-cyan-300"><Activity size={16} /> Normal pair</div>
        <p className="text-muted-foreground">Buy <b className="text-foreground">Over 4 + Under 5</b>, one stake on each contract, submitted together. If both settle on the same digit, exactly one wins. Broker buys are not atomic and may settle on different ticks.</p></div>
      <div><div className="mb-2 flex items-center gap-2 font-semibold text-amber-300"><ShieldCheck size={16} /> Recovery pair</div>
        <p className="text-muted-foreground">When the <b className="text-foreground">combined pair P/L is negative</b>, buy <b className="text-foreground">Over 5 + Under 4</b> until combined debt is cleared or a safety limit stops the bot. Digits 4 or 5 can make both recovery legs lose.</p></div>
    </CardContent></Card>

    <Card><CardContent className="space-y-4 p-4 md:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="font-semibold">Set the DBot risk limits</h2><p className="text-xs text-muted-foreground">These values affect the generated strategy, not the scanner's market ranking.</p></div>
        <Button onClick={runScan} disabled={scanning} className="gap-2"><ScanSearch size={16} className={scanning ? "animate-pulse" : ""} />{scanning ? "Checking live markets…" : "Scan markets"}</Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Stake per leg" hint="Normal pair costs twice this amount." value={form.stake} min={0.35} max={500} step={0.01} change={v => setForm(f => ({ ...f, stake: v }))} />
        <Field label="Take profit" hint="On this DBot session's combined P/L." value={form.takeProfit} min={0.01} max={100000} step={0.01} change={v => setForm(f => ({ ...f, takeProfit: v }))} />
        <Field label="Stop loss" hint="Both legs' worst-case cost checked before buy." value={form.stopLoss} min={0.01} max={100000} step={0.01} change={v => setForm(f => ({ ...f, stopLoss: v }))} />
        <Field label="Recovery pairs" hint="Stop if debt remains after this many attempts." value={form.maxRecoverySteps} min={1} max={10} change={v => setForm(f => ({ ...f, maxRecoverySteps: v }))} />
        <Field label="Max stake per leg" hint={`Account maximum ${accountMax.toFixed(2)}; two legs can risk twice this.`} value={form.maxStake} min={0.35} max={accountMax} step={0.01} change={v => setForm(f => ({ ...f, maxStake: v }))} />
      </div>
      <p className="text-xs leading-5 text-amber-200/80">Sizing illustration: if both normal $1 legs lose, debt = <b>$2, not $1</b>. With recovery payouts of 2.43× each and {markup}% markup, clearing $2 on a one-leg win needs about <b>{recoveryExample.toFixed(2)} per recovery leg</b> (total exposure {(recoveryExample * 2).toFixed(2)}). Live quotes, balance, stake cap and stop loss can reduce or prevent this trade. Neither pair guarantees profit.</p>
    </CardContent></Card>

    {scan && <section aria-live="polite" className="space-y-4">
      <div className={`rounded-lg border p-4 text-sm ${scan.dataSource === "unavailable" ? "border-amber-500/30 bg-amber-500/10" : "border-cyan-500/20 bg-cyan-500/5"}`}>
        <div className="flex flex-wrap items-center gap-3"><strong>{scan.dataSource === "broker-live" ? `${scan.eligible} qualified / ${scan.marketsChecked} checked` : "Verified feed unavailable"}</strong>
          {scan.dataSource === "broker-live" && <span className="text-xs text-muted-foreground">Live tick evidence · {expiresIn ? `qualification expires in ${expiresIn}s` : "qualification expired — re-scan"}</span>}</div>
        <p className="mt-1 text-xs text-muted-foreground">{scan.reason}</p>
      </div>
      {scan.markets.length > 0 && <div className="space-y-2">
        <div className="grid grid-cols-12 gap-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground"><span className="col-span-5 md:col-span-3">Market / broker ticks</span><span className="col-span-3 md:col-span-2">Digit 4</span><span className="col-span-3 md:col-span-2">Digit 5</span><span className="hidden md:block md:col-span-2">4 + 5 / recent</span><span className="hidden md:block md:col-span-3">Action</span></div>
        {scan.markets.map(m => <Card key={m.symbol} className={m.eligible ? "border-emerald-500/30" : "border-border"}><CardContent className="grid grid-cols-12 items-center gap-2 p-3 text-xs md:p-4">
          <div className="col-span-5 min-w-0 md:col-span-3"><div className="truncate font-semibold">{m.displayName}</div><div className="font-mono text-[10px] text-muted-foreground">{m.symbol} · {m.samples} ticks</div></div>
          <div className="col-span-3 font-mono md:col-span-2"><div>{pct(m.digit4.rate)}</div><div className="text-[10px] text-muted-foreground">upper {pct(m.digit4.upper)}</div></div>
          <div className="col-span-3 font-mono md:col-span-2"><div>{pct(m.digit5.rate)}</div><div className="text-[10px] text-muted-foreground">upper {pct(m.digit5.upper)}</div></div>
          <div className="col-span-1 md:hidden">{m.eligible ? <ShieldCheck className="h-4 w-4 text-emerald-400" /> : <AlertTriangle className="h-4 w-4 text-muted-foreground" />}</div>
          <div className="hidden font-mono md:col-span-2 md:block"><div>{pct(m.combined.rate)} combined</div><div className="text-[10px] text-muted-foreground">recent {pct(m.recentCombinedRate)}</div></div>
          <div className="col-span-12 mt-2 flex flex-wrap items-center justify-between gap-2 md:col-span-3 md:mt-0"><Badge variant="outline" className={m.eligible ? "border-emerald-500/30 text-emerald-300" : "text-muted-foreground"}>{m.eligible ? "Measured weak" : "Watch only"}</Badge>
            {m.eligible && <Button size="sm" variant="outline" className="h-8 gap-1.5 border-cyan-500/30 text-cyan-200 hover:bg-cyan-500/10" disabled={expiresIn === 0 || !!creating} onClick={() => createDbot(m)}>{creating === m.symbol ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Workflow className="h-3.5 w-3.5" />} Create DBot <ArrowRight className="h-3 w-3" /></Button>}</div>
          {!m.eligible && <p className="col-span-12 text-[11px] text-muted-foreground">{m.reason}</p>}
        </CardContent></Card>)}
      </div>}
    </section>}

    <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" /> One-sided confidence bounds are estimates from past broker ticks, not guarantees. Synthetic digit distributions can change; two 1-tick orders are not guaranteed the same entry or exit tick. If one normal contract wins at a payout below 2×, the pair may still lose money and enter recovery. Use a demo account to verify execution before risking real funds.</p>
  </div>;
}
