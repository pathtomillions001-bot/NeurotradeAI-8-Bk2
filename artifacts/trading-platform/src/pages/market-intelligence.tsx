import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Activity, AlertTriangle, BarChart3, CheckCircle2, Clock3, Crosshair, Database, Layers3, RefreshCw, ShieldCheck, Target, TrendingDown, TrendingUp, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const TIMEFRAMES = [
  { value: 60, label: "1m" },
  { value: 300, label: "5m" },
  { value: 900, label: "15m" },
  { value: 3600, label: "1h" },
  { value: 14400, label: "4h" },
  { value: 86400, label: "1D" },
];

const CATEGORIES = [
  { value: "all", label: "All live markets" },
  { value: "forex", label: "Forex" },
  { value: "cryptocurrency", label: "Crypto" },
  { value: "commodities", label: "Commodities" },
  { value: "indices", label: "Indices" },
  { value: "synthetic_index", label: "Synthetic / Derived" },
];

type Market = {
  symbol: string;
  displayName: string;
  category: string;
  categoryLabel: string;
  market: string;
  submarket: string;
  pipSize: number | null;
  exchangeIsOpen: boolean | null;
  isSuspended: boolean;
};

type Strategy = { name: string; stance: "BUY" | "SELL" | "NO_TRADE"; score: number; weight: number; evidence: string };
type Signal = {
  id: string;
  generatedAt: string;
  symbol: string;
  displayName: string;
  category: string;
  timeframeLabel: string;
  higherTimeframeLabel: string;
  signal: "BUY" | "SELL" | "NO_TRADE";
  confidence: number;
  modelProbability: number;
  dataFreshnessSeconds: number;
  validUntil: string;
  expectedDurationSeconds: number;
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  positionSizing: {
    balance: number;
    riskPercent: number;
    riskAmount: number;
    stopDistance: number;
    takeProfitDistance: number;
    unitsPerLot: number;
    recommendedLotSize: number;
    formula: string;
    basis: "indicative";
  };
  regime: string;
  higherTimeframeBias: "BUY" | "SELL" | "NO_TRADE";
  higherTimeframeAgreement: boolean;
  analytics: {
    price: number;
    returnMeanPercent: number;
    realizedVolatilityPercent: number;
    volatilityRegimeRatio: number;
    returnZScore: number;
    autocorrelation1: number;
    hurstExponent: number;
    permutationEntropy: number;
    quantile05: number;
    quantile95: number;
    support: number;
    resistance: number;
    macroStructure: string;
    microStructure: string;
    breakOfStructure: string;
    changeOfCharacter: string;
    liquiditySweep: string;
    displacement: string;
    reversalScore: number;
    deltaProxy: number;
    signedVolumeProxy: number;
    tickImbalance: number;
    tickRatePerMinute: number;
    orderflowQuality: string;
  };
  markov: { sampleSize: number; nextUpProbability: number; nextDownProbability: number; state: string; signal: string };
  monteCarlo: { paths: number; steps: number; tpBeforeSl: number; slBeforeTp: number; neither: number; method: string };
  strategies: Strategy[];
  guards: string[];
  rationale: string[];
  outcome: "OPEN" | "TP" | "SL" | "EXPIRED" | "AMBIGUOUS" | "UNVERIFIED";
  outcomeAt: string | null;
  outcomePrice: number | null;
  candles?: { epoch: number; open: number; high: number; low: number; close: number }[];
};

type MarketsResponse = { markets: Market[]; fetchedAt: string; liveDataOnly: true };
type SignalsResponse = { signals: Signal[]; liveDataOnly: true };

async function getJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error ?? "Live Deriv data is unavailable");
  return body as T;
}

function formatNumber(value: number | null | undefined, digits = 5): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatDuration(seconds: number): string {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 60)}m`;
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function MiniChart({ signal }: { signal: Signal }) {
  const candles = signal.candles ?? [];
  if (candles.length < 2) return <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">Live chart data will appear after analysis</div>;
  const points = candles.slice(-80);
  const min = Math.min(...points.map((candle) => candle.low));
  const max = Math.max(...points.map((candle) => candle.high));
  const range = Math.max(max - min, 1e-12);
  const coords = points.map((candle, index) => `${(index / (points.length - 1)) * 100},${100 - ((candle.close - min) / range) * 100}`).join(" ");
  const y = (price: number | null) => price == null ? null : 100 - ((price - min) / range) * 100;
  const entryY = y(signal.entry);
  const stopY = y(signal.stopLoss);
  const takeY = y(signal.takeProfit);
  return (
    <div className="relative h-48 overflow-hidden rounded-lg border border-border/70 bg-[#071019]">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="intel-chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#00e5ff" stopOpacity="0.25" />
            <stop offset="1" stopColor="#00e5ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polyline points={`0,100 ${coords} 100,100`} fill="url(#intel-chart-fill)" stroke="none" />
        <polyline points={coords} fill="none" stroke="#42e8ff" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
        {entryY != null && <line x1="0" x2="100" y1={entryY} y2={entryY} stroke="#a7b4c3" strokeDasharray="2 2" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />}
        {stopY != null && <line x1="0" x2="100" y1={stopY} y2={stopY} stroke="#fb7185" strokeDasharray="3 2" strokeWidth="0.55" vectorEffect="non-scaling-stroke" />}
        {takeY != null && <line x1="0" x2="100" y1={takeY} y2={takeY} stroke="#34d399" strokeDasharray="3 2" strokeWidth="0.55" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="absolute left-2 top-2 flex gap-3 text-[9px] font-mono uppercase tracking-wider">
        <span className="text-cyan-300">LIVE candles</span>
        <span className="text-muted-foreground">{signal.timeframeLabel}</span>
      </div>
      <div className="absolute right-2 top-2 space-y-1 text-right text-[9px] font-mono">
        <div className="text-slate-300">E {formatNumber(signal.entry)}</div>
        {signal.stopLoss != null && <div className="text-rose-300">SL {formatNumber(signal.stopLoss)}</div>}
        {signal.takeProfit != null && <div className="text-emerald-300">TP {formatNumber(signal.takeProfit)}</div>}
      </div>
    </div>
  );
}

function SignalBadge({ signal }: { signal: Signal["signal"] }) {
  const config = signal === "BUY"
    ? { icon: TrendingUp, label: "BUY", className: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" }
    : signal === "SELL"
      ? { icon: TrendingDown, label: "SELL", className: "border-rose-400/40 bg-rose-400/10 text-rose-300" }
      : { icon: Crosshair, label: "NO TRADE", className: "border-amber-400/40 bg-amber-400/10 text-amber-300" };
  const Icon = config.icon;
  return <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-bold tracking-wider ${config.className}`}><Icon className="h-3.5 w-3.5" />{config.label}</span>;
}

function Metric({ label, value, tone = "text-foreground" }: { label: string; value: string; tone?: string }) {
  return <div className="rounded-md border border-border/70 bg-background/40 p-2.5"><div className="text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div><div className={`mt-1 font-mono text-sm font-semibold ${tone}`}>{value}</div></div>;
}

function OutcomeBadge({ outcome }: { outcome: Signal["outcome"] }) {
  const tone = outcome === "TP" ? "text-emerald-300 border-emerald-400/30 bg-emerald-400/10" : outcome === "SL" ? "text-rose-300 border-rose-400/30 bg-rose-400/10" : outcome === "OPEN" ? "text-cyan-300 border-cyan-400/30 bg-cyan-400/10" : "text-muted-foreground border-border bg-secondary/40";
  return <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold tracking-wider ${tone}`}>{outcome}</span>;
}

export default function MarketIntelligence() {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState("forex");
  const [search, setSearch] = useState("");
  const [symbol, setSymbol] = useState("");
  const [timeframe, setTimeframe] = useState(900);
  const [balance, setBalance] = useState("");
  const [riskPercent, setRiskPercent] = useState("0.5");
  const [unitsPerLot, setUnitsPerLot] = useState("");
  const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null);

  const marketsQuery = useQuery({
    queryKey: ["market-intelligence-markets", category, search],
    queryFn: () => getJson<MarketsResponse>(`/api/market-intelligence/markets?category=${encodeURIComponent(category)}&search=${encodeURIComponent(search)}`),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const signalsQuery = useQuery({
    queryKey: ["market-intelligence-signals"],
    queryFn: () => getJson<SignalsResponse>("/api/market-intelligence/signals?limit=20"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const markets = marketsQuery.data?.markets ?? [];
  useEffect(() => {
    if (markets.length && !markets.some((market) => market.symbol === symbol)) setSymbol(markets[0].symbol);
  }, [markets, symbol]);

  const analyze = useMutation({
    mutationFn: () => getJson<Signal>("/api/market-intelligence/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, timeframeSeconds: timeframe, balance: balance === "" ? undefined : Number(balance), riskPercent: Number(riskPercent), unitsPerLot: unitsPerLot === "" ? undefined : Number(unitsPerLot) }),
    }),
    onSuccess: (data) => {
      setSelectedSignal(data);
      queryClient.invalidateQueries({ queryKey: ["market-intelligence-signals"] });
    },
  });

  const currentSignal = selectedSignal ?? signalsQuery.data?.signals?.[0] ?? null;
  const selectedMarket = useMemo(() => markets.find((market) => market.symbol === symbol), [markets, symbol]);
  const liveUnavailable = marketsQuery.isError;

  return (
    <div className="min-h-full bg-[#06090e] text-slate-100">
      <div className="border-b border-cyan-300/10 bg-[#08121b] px-4 py-4 md:px-7">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-300"><Activity className="h-3.5 w-3.5" /> NeuroTrade / Market Intelligence</div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Advanced quantitative signal desk</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-400">Multi-timeframe live-candle analysis using fractal structure, liquidity behavior, reversal math, realized distributions, Markov states, entropy, volatility regimes, and a clearly labelled tick-flow proxy.</p>
          </div>
          <div className="flex items-center gap-2 self-start rounded-md border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-[10px] font-mono uppercase tracking-wider text-emerald-300 lg:self-auto"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" /> Live feed only · signal mode</div>
        </div>
      </div>

      <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-7">
        <Card className="border-cyan-300/15 bg-[#0a1119] shadow-[0_12px_50px_rgba(0,0,0,0.18)]">
          <CardContent className="grid gap-3 p-4 md:grid-cols-2 lg:grid-cols-6 lg:items-end">
            <label className="space-y-1.5 lg:col-span-2"><span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Market universe</span><select value={category} onChange={(event) => setCategory(event.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-cyan-300/60">{CATEGORIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label className="space-y-1.5 lg:col-span-2"><span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Search live symbols</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="XAUUSD, EURUSD, Volatility…" className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-cyan-300/60" /></label>
            <label className="space-y-1.5 lg:col-span-2"><span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Instrument</span><select value={symbol} onChange={(event) => setSymbol(event.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2 font-mono text-xs outline-none focus:border-cyan-300/60"><option value="">Select from live feed…</option>{markets.map((market) => <option key={market.symbol} value={market.symbol}>{market.symbol} · {market.displayName}</option>)}</select></label>
            <div className="lg:col-span-6 flex flex-wrap items-end gap-2 border-t border-border/60 pt-3">
              <div className="mr-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Analysis timeframe</div>
              {TIMEFRAMES.map((item) => <button key={item.value} onClick={() => setTimeframe(item.value)} className={`rounded-md border px-3 py-1.5 text-xs font-mono transition-colors ${timeframe === item.value ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-200" : "border-border bg-background/50 text-muted-foreground hover:text-foreground"}`}>{item.label}</button>)}
              <label className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">Balance <input inputMode="decimal" value={balance} onChange={(event) => setBalance(event.target.value)} placeholder="account" className="h-8 w-24 rounded border border-border bg-background px-2 font-mono text-xs text-foreground" /></label>
              <label className="flex items-center gap-2 text-[10px] text-muted-foreground">Risk % <input inputMode="decimal" value={riskPercent} onChange={(event) => setRiskPercent(event.target.value)} className="h-8 w-16 rounded border border-border bg-background px-2 font-mono text-xs text-foreground" /></label>
              <label className="flex items-center gap-2 text-[10px] text-muted-foreground">Units/lot <input inputMode="decimal" value={unitsPerLot} onChange={(event) => setUnitsPerLot(event.target.value)} placeholder="auto" className="h-8 w-20 rounded border border-border bg-background px-2 font-mono text-xs text-foreground" /></label>
              <Button onClick={() => analyze.mutate()} disabled={!symbol || analyze.isPending || liveUnavailable} className="h-8 gap-2 bg-cyan-400 text-slate-950 hover:bg-cyan-300">{analyze.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Crosshair className="h-3.5 w-3.5" />} Analyze live</Button>
            </div>
          </CardContent>
        </Card>

        {liveUnavailable && <Card className="border-amber-400/30 bg-amber-400/5"><CardContent className="flex items-start gap-3 p-4 text-xs text-amber-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><div className="font-bold uppercase tracking-wider">No live feed — no signal generated</div><div className="mt-1 text-amber-200/70">{(marketsQuery.error as Error)?.message ?? "Deriv's live public candle endpoint could not be reached. This feature fails closed and never substitutes simulated prices."}</div></div></CardContent></Card>}
        {analyze.isError && <Card className="border-rose-400/30 bg-rose-400/5"><CardContent className="flex items-start gap-3 p-4 text-xs text-rose-200"><XCircle className="mt-0.5 h-4 w-4 shrink-0" /><div><div className="font-bold uppercase tracking-wider">Analysis withheld</div><div className="mt-1 text-rose-200/70">{(analyze.error as Error)?.message}</div></div></CardContent></Card>}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.85fr)]">
          <Card className="border-cyan-300/15 bg-[#0a1119]">
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2"><div><CardTitle className="flex items-center gap-2 text-sm font-medium"><BarChart3 className="h-4 w-4 text-cyan-300" /> Decision panel</CardTitle><p className="mt-1 text-[11px] text-muted-foreground">{currentSignal ? `${currentSignal.displayName} · ${currentSignal.timeframeLabel} vs ${currentSignal.higherTimeframeLabel}` : "Select a live market and request an analysis"}</p></div>{currentSignal && <SignalBadge signal={currentSignal.signal} />}</CardHeader>
            <CardContent>{!currentSignal ? <div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-muted-foreground"><Database className="h-8 w-8 opacity-30" /><div className="text-sm">Awaiting a live analysis</div><div className="max-w-sm text-[11px]">No cached or simulated quote is displayed here. The first result is created only after Deriv returns fresh candles.</div></div> : <div className="space-y-3"><MiniChart signal={currentSignal} /><div className="grid grid-cols-2 gap-2 md:grid-cols-4"><Metric label="Confidence" value={`${currentSignal.confidence.toFixed(1)}%`} tone={currentSignal.confidence >= 60 ? "text-emerald-300" : "text-amber-300"} /><Metric label="MC TP first" value={currentSignal.monteCarlo.paths ? `${(currentSignal.monteCarlo.tpBeforeSl * 100).toFixed(1)}%` : "—"} /><Metric label="Regime" value={currentSignal.regime.replaceAll("_", " ")} /><Metric label="Freshness" value={`${currentSignal.dataFreshnessSeconds}s`} tone={currentSignal.dataFreshnessSeconds < 120 ? "text-emerald-300" : "text-amber-300"} /></div><div className="grid grid-cols-2 gap-2 md:grid-cols-4"><Metric label="Entry" value={formatNumber(currentSignal.entry)} /><Metric label="Stop loss" value={formatNumber(currentSignal.stopLoss)} tone="text-rose-300" /><Metric label="Take profit" value={formatNumber(currentSignal.takeProfit)} tone="text-emerald-300" /><Metric label="R:R" value={currentSignal.riskReward ? `1 : ${currentSignal.riskReward.toFixed(1)}` : "—"} tone="text-cyan-300" /></div><div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3 text-[10px] text-muted-foreground"><span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" /> Valid until {new Date(currentSignal.validUntil).toLocaleTimeString()}</span><span>·</span><span>Expected hold {formatDuration(currentSignal.expectedDurationSeconds)}</span><span>·</span><span>HTF {currentSignal.higherTimeframeBias} {currentSignal.higherTimeframeAgreement ? "aligned" : "conflicted"}</span></div></div>}</CardContent>
          </Card>

          <Card className="border-cyan-300/15 bg-[#0a1119]"><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4 text-emerald-300" /> Risk & sizing</CardTitle><p className="text-[11px] text-muted-foreground">Indicative sizing only — confirm Deriv contract specifications.</p></CardHeader><CardContent>{currentSignal ? <div className="space-y-3"><div className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3"><div className="text-[10px] uppercase tracking-widest text-emerald-300/80">Recommended lot size</div><div className="mt-1 font-mono text-3xl font-semibold text-emerald-200">{currentSignal.positionSizing.recommendedLotSize ? currentSignal.positionSizing.recommendedLotSize.toFixed(4) : "—"}</div><div className="mt-1 text-[10px] text-muted-foreground">{currentSignal.positionSizing.basis} · {currentSignal.positionSizing.unitsPerLot.toLocaleString()} units/lot</div></div><div className="grid grid-cols-2 gap-2"><Metric label="Account balance" value={formatNumber(currentSignal.positionSizing.balance, 2)} /><Metric label="Risk amount" value={formatNumber(currentSignal.positionSizing.riskAmount, 2)} /><Metric label="Risk %" value={`${currentSignal.positionSizing.riskPercent.toFixed(2)}%`} /><Metric label="SL distance" value={formatNumber(currentSignal.positionSizing.stopDistance)} /></div><div className="rounded border border-border bg-background/40 p-2 text-[10px] leading-relaxed text-muted-foreground"><span className="font-bold text-slate-300">Formula: </span>{currentSignal.positionSizing.formula}<br /><span className="text-amber-300/80">This tool does not place orders and must not be used as a guarantee of loss containment.</span></div></div> : <div className="py-14 text-center text-xs text-muted-foreground">Sizing appears with a live analysis. Enter balance and risk first.</div>}</CardContent></Card>
        </div>

        {currentSignal && <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]"><Card className="border-cyan-300/15 bg-[#0a1119]"><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm font-medium"><Layers3 className="h-4 w-4 text-violet-300" /> Ensemble evidence</CardTitle><p className="text-[11px] text-muted-foreground">Transparent modules; disagreement is a reason to stand aside.</p></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-[11px]"><thead className="border-b border-border text-[9px] uppercase tracking-widest text-muted-foreground"><tr><th className="pb-2 font-medium">Module</th><th className="pb-2 font-medium">Stance</th><th className="pb-2 font-medium">Score</th><th className="pb-2 font-medium">Evidence</th></tr></thead><tbody>{currentSignal.strategies.map((strategy) => <tr key={strategy.name} className="border-b border-border/40"><td className="py-2 font-medium text-slate-300">{strategy.name}</td><td className={`py-2 font-mono font-bold ${strategy.stance === "BUY" ? "text-emerald-300" : strategy.stance === "SELL" ? "text-rose-300" : "text-muted-foreground"}`}>{strategy.stance}</td><td className="py-2 font-mono text-cyan-200">{strategy.score.toFixed(1)}</td><td className="py-2 text-muted-foreground">{strategy.evidence}</td></tr>)}</tbody></table></div></CardContent></Card><Card className="border-cyan-300/15 bg-[#0a1119]"><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm font-medium"><Target className="h-4 w-4 text-amber-300" /> Probability & guardrails</CardTitle></CardHeader><CardContent className="space-y-2.5 text-xs"><div className="grid grid-cols-2 gap-2 md:grid-cols-3"><Metric label="Markov next up" value={`${(currentSignal.markov.nextUpProbability * 100).toFixed(1)}%`} /><Metric label="Markov states" value={currentSignal.markov.sampleSize.toString()} /><Metric label="Hurst exponent" value={currentSignal.analytics.hurstExponent.toFixed(2)} /><Metric label="Entropy" value={currentSignal.analytics.permutationEntropy.toFixed(2)} /><Metric label="Delta proxy" value={currentSignal.analytics.deltaProxy.toFixed(3)} /><Metric label="SVolume proxy" value={currentSignal.analytics.signedVolumeProxy.toFixed(3)} /></div><div className="rounded border border-border bg-background/40 p-3 text-[10px] leading-relaxed text-muted-foreground"><div className="mb-1 font-bold uppercase tracking-widest text-slate-300">Why this result?</div>{currentSignal.rationale.map((item) => <div key={item} className="mb-1 last:mb-0">• {item}</div>)}</div>{currentSignal.guards.length > 0 && <div className="rounded border border-amber-400/25 bg-amber-400/5 p-3 text-[10px] text-amber-200"><div className="mb-1 font-bold uppercase tracking-widest">Vetoes</div>{currentSignal.guards.map((guard) => <div key={guard} className="mb-1 last:mb-0">• {guard}</div>)}</div>}<div className="text-[10px] text-muted-foreground">Monte Carlo uses bootstrap resampling of live returns and is scenario analysis, not a promise of future performance.</div></CardContent></Card></div>}

        <Card className="border-cyan-300/15 bg-[#0a1119]"><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><div><CardTitle className="flex items-center gap-2 text-sm font-medium"><Clock3 className="h-4 w-4 text-cyan-300" /> Recent signal tape</CardTitle><p className="mt-1 text-[11px] text-muted-foreground">Only signals generated by this independent live-candle desk. Outcomes are checked against fresh Deriv candles.</p></div><button onClick={() => signalsQuery.refetch()} className="text-muted-foreground hover:text-foreground"><RefreshCw className={`h-4 w-4 ${signalsQuery.isFetching ? "animate-spin" : ""}`} /></button></CardHeader><CardContent>{(signalsQuery.data?.signals?.length ?? 0) === 0 ? <div className="py-8 text-center text-xs text-muted-foreground">No signal history yet.</div> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[11px]"><thead className="border-b border-border text-[9px] uppercase tracking-widest text-muted-foreground"><tr><th className="pb-2 font-medium">Time</th><th className="pb-2 font-medium">Market</th><th className="pb-2 font-medium">TF</th><th className="pb-2 font-medium">Signal</th><th className="pb-2 font-medium">Confidence</th><th className="pb-2 font-medium">Entry</th><th className="pb-2 font-medium">Outcome</th><th className="pb-2"></th></tr></thead><tbody>{signalsQuery.data?.signals.map((item) => <tr key={item.id} className="border-b border-border/40"><td className="py-2 font-mono text-muted-foreground">{timeAgo(item.generatedAt)}</td><td className="py-2"><div className="font-medium">{item.displayName}</div><div className="font-mono text-[9px] text-muted-foreground">{item.symbol}</div></td><td className="py-2 font-mono text-slate-300">{item.timeframeLabel}</td><td className="py-2"><SignalBadge signal={item.signal} /></td><td className="py-2 font-mono text-cyan-200">{item.confidence.toFixed(1)}%</td><td className="py-2 font-mono">{formatNumber(item.entry)}</td><td className="py-2"><OutcomeBadge outcome={item.outcome} /></td><td className="py-2 text-right"><button onClick={() => setSelectedSignal(item)} className="text-[10px] text-cyan-300 hover:text-cyan-100">Inspect</button></td></tr>)}</tbody></table></div>}</CardContent></Card>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[10px] text-muted-foreground"><span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-300" /> No simulated prices in this module</span><span>Analysis is advisory only. Market conditions can change before a candle closes.</span><Link href="/markets" className="text-cyan-300 hover:text-cyan-100">Back to options market scanner →</Link></div>
      </div>
    </div>
  );
}
