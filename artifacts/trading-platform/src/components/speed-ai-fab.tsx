import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  X, Zap, TrendingUp, Hash, Equal, Loader2, StopCircle,
  BarChart2, ScanSearch, CheckCircle2, AlertTriangle, RefreshCw,
  Lock, Shuffle, ShieldCheck, Activity, Brain,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useGetSettings } from "@workspace/api-client-react";
import {
  OVER_PAYOUTS,
  UNDER_PAYOUTS,
  EVEN_ODD_PAYOUT,
  RISE_FALL_PAYOUT,
  MATCH_PAYOUT,
  DIFF_PAYOUT,
  exactRecoveryStake,
  roundRecoveryStakeUp,
} from "@/lib/payouts";

// ── Types ─────────────────────────────────────────────────────────────────────

type ContractFamily = "overUnder" | "riseFall" | "evenOdd" | "differ" | "match";
type RecoveryMethod = "split" | "instant";
type MarketMode = "switching" | "locked";
type Step = "config" | "scanning" | "scan-result" | "running";

interface SpeedConfig {
  normalFamily: ContractFamily;
  normalOverBarrier: number;
  normalUnderBarrier: number;
  recoveryFamilies: ContractFamily[];
  recoveryAutoMode: boolean;
  recoveryOverBarrier: number;
  recoveryUnderBarrier: number;
  marketMode: MarketMode;
  lockedSymbol: string;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  recoveryMultiplier: number;
  recoveryMethod: RecoveryMethod;
  maxRecoverySteps: number;
}

interface MarketScore {
  symbol: string;
  displayName: string;
  contractType: string;
  barrier?: number;
  score: number;
  normalScore?: number;
  recoveryScore?: number;
  winProbability: number;
  expectedValue?: number;
  entropyBits?: number;
  isStructured?: boolean;
  reason: string;
}

interface ScanResult {
  suitable: boolean;
  best: MarketScore | null;
  allScored: MarketScore[];
  reason: string;
}

interface ScanProgress {
  scanning: string | null;
  scanningSymbol: string | null;
  scanned: number;
  total: number;
  results: Array<{
    symbol: string;
    score: number;
    normalScore?: number;
    recoveryScore?: number;
    entropyBits?: number;
  }>;
}

interface SessionStatus {
  running: boolean;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  recoveryTargetProfit: number;
  recoveryRemainingTargetProfit: number;
  recoveryOriginPayout: number;
  consecutiveRecoveryLosses: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  entropyBits?: number;
  expectedValue?: number;
  config?: {
    stake: number;
    stopLoss: number;
    takeProfit: number;
    recoveryAutoMode: boolean;
    recoveryMultiplier: number;
    recoveryMethod: string;
    maxRecoverySteps: number;
    normalContractTypes: string[];
    recoveryContractTypes: string[];
    normalBarriers: number[];
    recoveryBarriers: number[];
    marketMode?: string;
    lockedSymbol?: string;
  };
  topMarkets?: MarketScore[];
}

// ── Synthetic Markets Catalog ─────────────────────────────────────────────────

const ALL_SCAN_MARKETS: { symbol: string; short: string; name: string; group: string }[] = [
  { symbol: "R_10",    short: "V10",  name: "Volatility 10 Index",       group: "V"  },
  { symbol: "R_25",    short: "V25",  name: "Volatility 25 Index",       group: "V"  },
  { symbol: "R_50",    short: "V50",  name: "Volatility 50 Index",       group: "V"  },
  { symbol: "R_75",    short: "V75",  name: "Volatility 75 Index",       group: "V"  },
  { symbol: "R_100",   short: "V100", name: "Volatility 100 Index",      group: "V"  },
  { symbol: "1HZ10V",  short: "1s10", name: "Volatility 10 (1s) Index",  group: "1s" },
  { symbol: "1HZ15V",  short: "1s15", name: "Volatility 15 (1s) Index",  group: "1s" },
  { symbol: "1HZ25V",  short: "1s25", name: "Volatility 25 (1s) Index",  group: "1s" },
  { symbol: "1HZ30V",  short: "1s30", name: "Volatility 30 (1s) Index",  group: "1s" },
  { symbol: "1HZ50V",  short: "1s50", name: "Volatility 50 (1s) Index",  group: "1s" },
  { symbol: "1HZ75V",  short: "1s75", name: "Volatility 75 (1s) Index",  group: "1s" },
  { symbol: "1HZ90V",  short: "1s90", name: "Volatility 90 (1s) Index",  group: "1s" },
  { symbol: "1HZ100V", short: "1s1",  name: "Volatility 100 (1s) Index", group: "1s" },
  { symbol: "JD10",    short: "J10",  name: "Jump 10 Index",             group: "J"  },
  { symbol: "JD25",    short: "J25",  name: "Jump 25 Index",             group: "J"  },
  { symbol: "JD50",    short: "J50",  name: "Jump 50 Index",             group: "J"  },
  { symbol: "JD75",    short: "J75",  name: "Jump 75 Index",             group: "J"  },
  { symbol: "RDBULL",  short: "Bull", name: "Bull Market Index",         group: "I"  },
  { symbol: "RDBEAR",  short: "Bear", name: "Bear Market Index",         group: "I"  },
];
const SCAN_MARKET_COUNT = ALL_SCAN_MARKETS.length;

// ── Contract Families ─────────────────────────────────────────────────────────

const NORMAL_FAMILIES: { id: ContractFamily; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "overUnder", label: "Over & Under", icon: <Hash className="w-3.5 h-3.5" />, desc: "Digit barrier trades" },
  { id: "riseFall",  label: "Rise & Fall",  icon: <TrendingUp className="w-3.5 h-3.5" />, desc: "Price direction trades" },
  { id: "evenOdd",   label: "Even & Odd",   icon: <Equal className="w-3.5 h-3.5" />, desc: "Digit parity trades" },
  { id: "differ",    label: "Differs",      icon: <BarChart2 className="w-3.5 h-3.5" />, desc: "Cold-digit avoidance (~96% win)" },
];

const RECOVERY_FAMILIES: { id: ContractFamily; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "overUnder", label: "Over & Under", icon: <Hash className="w-3.5 h-3.5" />, desc: "Digit barrier trades" },
  { id: "riseFall",  label: "Rise & Fall",  icon: <TrendingUp className="w-3.5 h-3.5" />, desc: "Price direction trades" },
  { id: "evenOdd",   label: "Even & Odd",   icon: <Equal className="w-3.5 h-3.5" />, desc: "Digit parity trades" },
  { id: "match",     label: "Matches",      icon: <BarChart2 className="w-3.5 h-3.5" />, desc: "Hot-digit recovery (8.93× payout)" },
];

function familyToContracts(family: ContractFamily, overB: number, underB: number) {
  switch (family) {
    case "overUnder":  return { types: ["DIGITOVER", "DIGITUNDER"], barriers: [overB, underB] };
    case "riseFall":   return { types: ["CALL", "PUT"], barriers: [] };
    case "evenOdd":    return { types: ["DIGITEVEN", "DIGITODD"], barriers: [] };
    case "differ":     return { types: ["DIGITDIFF"], barriers: [] };
    case "match":      return { types: ["DIGITMATCH"], barriers: [] };
  }
}

function scoreColor(score: number) {
  if (score >= 60) return "text-green-400";
  if (score >= 54) return "text-cyan-400";
  if (score >= 48) return "text-amber-400";
  return "text-red-400";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NumInput({ label, value, onChange, min, max, step = 1, suffix }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground flex-1">{label}</span>
      <div className="flex items-center gap-1">
        <Input
          type="number" value={value} min={min} max={max} step={step}
          onChange={e => onChange(Number(e.target.value))}
          className="w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus:border-cyan-500/50"
        />
        {suffix && <span className="text-[10px] text-muted-foreground w-6">{suffix}</span>}
      </div>
    </div>
  );
}

function FamilySelector({ label, value, onChange, families }: {
  label: string; value: ContractFamily; onChange: (v: ContractFamily) => void;
  families: { id: ContractFamily; label: string; icon: React.ReactNode; desc: string }[];
}) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
      <div className="grid grid-cols-2 gap-1.5">
        {families.map(f => (
          <button
            key={f.id}
            onClick={() => onChange(f.id)}
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-left text-xs border transition-all ${
              value === f.id
                ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-300 shadow-sm shadow-cyan-500/20"
                : "bg-white/5 border-white/10 text-muted-foreground hover:border-white/20"
            }`}
          >
            <span className={value === f.id ? "text-cyan-400" : "text-muted-foreground"}>{f.icon}</span>
            <span className="font-medium truncate">{f.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MultiFamilySelector({ label, value, onChange, families }: {
  label: string;
  value: ContractFamily[];
  onChange: (v: ContractFamily[]) => void;
  families: { id: ContractFamily; label: string; icon: React.ReactNode; desc: string }[];
}) {
  const toggle = (id: ContractFamily) => {
    if (value.includes(id)) {
      if (value.length === 1) return;
      onChange(value.filter(f => f !== id));
    } else {
      onChange([...value, id]);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
        <span className="text-[9px] text-cyan-400 font-mono">Strict Contract Lock</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {families.map(f => {
          const active = value.includes(f.id);
          return (
            <button
              key={f.id}
              onClick={() => toggle(f.id)}
              className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-left text-xs border transition-all ${
                active
                  ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-300 shadow-sm shadow-cyan-500/20"
                  : "bg-white/5 border-white/10 text-muted-foreground hover:border-white/20"
              }`}
            >
              <span className={active ? "text-cyan-400" : "text-muted-foreground"}>{f.icon}</span>
              <span className="font-medium truncate">{f.label}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[9px] text-muted-foreground/50">Recovery executes exclusively within your enabled family.</p>
    </div>
  );
}

function BarrierRow({ label, overBarrier, underBarrier, onOverBarrier, onUnderBarrier }: {
  label: string; overBarrier: number; underBarrier: number;
  onOverBarrier: (v: number) => void; onUnderBarrier: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] text-muted-foreground/60">{label}</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">OVER digit</p>
          <Select value={String(overBarrier)} onValueChange={v => onOverBarrier(Number(v))}>
            <SelectTrigger className="h-7 text-xs bg-black/30 border-white/10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0,1,2,3,4,5,6,7,8].map(b => (
                <SelectItem key={b} value={String(b)}>OVER {b} · {(100*(9-b)/10).toFixed(0)}% · {OVER_PAYOUTS[b].toFixed(2)}×</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">UNDER digit</p>
          <Select value={String(underBarrier)} onValueChange={v => onUnderBarrier(Number(v))}>
            <SelectTrigger className="h-7 text-xs bg-black/30 border-white/10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1,2,3,4,5,6,7,8,9].map(b => (
                <SelectItem key={b} value={String(b)}>UNDER {b} · {(100*b/10).toFixed(0)}% · {UNDER_PAYOUTS[b].toFixed(2)}×</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

// ── Main NeuroAI FAB Component ────────────────────────────────────────────────

export function SpeedAIFab() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress>({
    scanning: null, scanningSymbol: null, scanned: 0, total: SCAN_MARKET_COUNT, results: [],
  });
  const { data: settings } = useGetSettings();

  const [config, setConfig] = useState<SpeedConfig>({
    normalFamily: "overUnder",
    normalOverBarrier: 1,
    normalUnderBarrier: 8,
    recoveryFamilies: ["overUnder"],
    recoveryAutoMode: true,
    recoveryOverBarrier: 4,
    recoveryUnderBarrier: 5,
    marketMode: "switching",
    lockedSymbol: "1HZ100V",
    stake: 1,
    stopLoss: 5,
    takeProfit: 10,
    recoveryMultiplier: 1.62,
    recoveryMethod: "split",
    maxRecoverySteps: 3,
  });

  const set = <K extends keyof SpeedConfig>(k: K, v: SpeedConfig[K]) =>
    setConfig(prev => ({ ...prev, [k]: v }));

  const settingsLoadedRef = useRef(false);
  useEffect(() => {
    if (!settings || settingsLoadedRef.current) return;
    settingsLoadedRef.current = true;
    const s = settings as any;
    setConfig(prev => ({
      ...prev,
      normalOverBarrier:    s.normalOverDigit    ?? prev.normalOverBarrier,
      normalUnderBarrier:   s.normalUnderDigit   ?? prev.normalUnderBarrier,
      recoveryOverBarrier:  s.recoveryOverDigit  ?? prev.recoveryOverBarrier,
      recoveryUnderBarrier: s.recoveryUnderDigit ?? prev.recoveryUnderBarrier,
      recoveryAutoMode:     s.recoveryAutoMode   ?? prev.recoveryAutoMode,
      recoveryMultiplier:   s.recoveryMultiplier ?? prev.recoveryMultiplier,
      recoveryMethod:       (s.recoveryMethod    ?? prev.recoveryMethod) as RecoveryMethod,
      maxRecoverySteps:     s.maxRecoverySteps   ?? prev.maxRecoverySteps,
      stake:                s.riskAmountValue    ?? prev.stake,
    }));
  }, [settings]);

  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/speed-ai/status");
      if (res.ok) {
        const data: SessionStatus = await res.json();
        setStatus(data);
        if (data.running) setStep("running");
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    const intervalMs = open ? 1000 : 3000;
    pollRef.current = setInterval(fetchStatus, intervalMs);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, fetchStatus]);

  const pendingStatusRef = useRef<SessionStatus | null>(null);
  const rafRef = useRef<number | null>(null);

  const applyStatus = useCallback((data: SessionStatus) => {
    pendingStatusRef.current = data;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const latest = pendingStatusRef.current;
      if (!latest) return;
      pendingStatusRef.current = null;
      setStatus(latest);
      if (latest.running) setStep("running");
    });
  }, []);

  useEffect(() => {
    let es: EventSource;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      es = new EventSource("/api/ai/events");

      es.addEventListener("speed_ai_update", (e: MessageEvent) => {
        try { applyStatus(JSON.parse(e.data) as SessionStatus); } catch { /* ignore */ }
      });

      es.addEventListener("speed_ai_scan_progress", (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data) as {
            scanning: string | null;
            symbol: string | null;
            scanned: number;
            total: number;
            results: Array<{ symbol: string; score: number; normalScore?: number; recoveryScore?: number; entropyBits?: number }>;
          };
          setScanProgress({
            scanning: p.scanning,
            scanningSymbol: p.symbol,
            scanned: p.scanned,
            total: p.total,
            results: p.results,
          });
        } catch { /* ignore */ }
      });

      es.onerror = () => {
        es.close();
        if (!destroyed) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      es?.close();
    };
  }, [applyStatus]);

  // ── Build Request Body ──────────────────────────────────────────────────────
  function buildBody(forcedLockedSymbol?: string, forcedMode?: MarketMode) {
    const normalContracts = familyToContracts(config.normalFamily, config.normalOverBarrier, config.normalUnderBarrier);

    const recoveryTypes: string[] = [];
    const recoveryBarrierSet: number[] = [];
    for (const family of config.recoveryFamilies) {
      const c = familyToContracts(family, config.recoveryOverBarrier, config.recoveryUnderBarrier);
      for (const t of c.types)    if (!recoveryTypes.includes(t))       recoveryTypes.push(t);
      for (const b of c.barriers) if (!recoveryBarrierSet.includes(b)) recoveryBarrierSet.push(b);
    }
    if (recoveryTypes.length === 0) {
      recoveryTypes.push("DIGITOVER", "DIGITUNDER");
      recoveryBarrierSet.push(config.recoveryOverBarrier, config.recoveryUnderBarrier);
    }

    const effectiveMode = forcedMode ?? config.marketMode;
    const effectiveLockedSymbol = forcedLockedSymbol ?? (effectiveMode === "locked" ? config.lockedSymbol : undefined);

    return {
      normalContractTypes:   normalContracts.types,
      normalBarriers:        normalContracts.barriers,
      recoveryContractTypes: recoveryTypes,
      recoveryBarriers:      recoveryBarrierSet,
      stake:                 config.stake,
      stopLoss:              config.stopLoss,
      takeProfit:            config.takeProfit,
      recoveryAutoMode:      config.recoveryAutoMode,
      recoveryMultiplier:    config.recoveryMultiplier,
      recoveryMethod:        config.recoveryMethod,
      maxRecoverySteps:      config.maxRecoverySteps,
      marketMode:            effectiveMode,
      ...(effectiveLockedSymbol ? { lockedSymbol: effectiveLockedSymbol } : {}),
    };
  }

  // ── Scan Markets ────────────────────────────────────────────────────────────
  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setScanProgress({ scanning: null, scanningSymbol: null, scanned: 0, total: SCAN_MARKET_COUNT, results: [] });
    try {
      const res = await fetch("/api/speed-ai/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data: ScanResult = await res.json();
      if (!res.ok) {
        toast.error((data as any).error ?? "Scan failed");
        setStep("config");
        return;
      }
      setScanResult(data);
      setStep("scan-result");
    } catch {
      toast.error("Could not connect to analysis engine");
      setStep("config");
    } finally {
      setLoading(false);
    }
  };

  // ── Start Trading Session ───────────────────────────────────────────────────
  const handleStart = async (symbolToLock?: string, mode?: MarketMode) => {
    setLoading(true);
    try {
      const payload = buildBody(symbolToLock, mode);
      const res = await fetch("/api/speed-ai/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to start NeuroAI");
        return;
      }
      setStatus(data.status);
      setStep("running");
      toast.success(
        payload.marketMode === "switching"
          ? "⚡ NeuroAI Live — Dynamic Strategy Switching active"
          : `⚡ NeuroAI Live — Locked on ${payload.lockedSymbol ?? "selected asset"}`
      );
    } catch {
      toast.error("Could not start NeuroAI session");
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/speed-ai/stop", { method: "POST" });
      const data = await res.json();
      setStatus(data.status);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setStep("config");
    setScanResult(null);
    setStatus(null);
  };

  const isRunning = status?.running ?? false;
  const profitColor = (status?.totalProfit ?? 0) >= 0 ? "text-green-400" : "text-red-400";
  const winRate = status && status.tradeCount > 0
    ? Math.round((status.winCount / status.tradeCount) * 100) : 0;

  return (
    <>
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 z-40"
              onClick={() => setOpen(false)}
            />

            {/* Panel */}
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 400, damping: 35 }}
              className="fixed bottom-20 right-4 z-50 w-84 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border border-cyan-500/25 bg-[#080d17] shadow-2xl shadow-cyan-950/50"
            >
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-white/5 bg-gradient-to-r from-cyan-950/40 via-blue-950/20 to-transparent">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
                    <Brain className="w-4 h-4 text-cyan-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                      NeuroAI Quantum FAB
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-normal">v4</span>
                    </h3>
                  </div>
                </div>
                <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-white p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* ── STEP: CONFIG ── */}
              {step === "config" && (
                <div className="p-4 space-y-4">
                  {/* Normal Strategy Selection */}
                  <FamilySelector
                    label="Normal Trade Strategy"
                    value={config.normalFamily}
                    onChange={v => set("normalFamily", v)}
                    families={NORMAL_FAMILIES}
                  />

                  {config.normalFamily === "overUnder" && (
                    <BarrierRow
                      label="Normal barriers"
                      overBarrier={config.normalOverBarrier}
                      underBarrier={config.normalUnderBarrier}
                      onOverBarrier={v => set("normalOverBarrier", v)}
                      onUnderBarrier={v => set("normalUnderBarrier", v)}
                    />
                  )}

                  {/* Recovery Strategy Selection */}
                  <MultiFamilySelector
                    label="Sniper Recovery Strategy"
                    value={config.recoveryFamilies}
                    onChange={v => set("recoveryFamilies", v)}
                    families={RECOVERY_FAMILIES}
                  />

                  {config.recoveryFamilies.includes("overUnder") && (
                    <BarrierRow
                      label="Recovery barriers (Over/Under)"
                      overBarrier={config.recoveryOverBarrier}
                      underBarrier={config.recoveryUnderBarrier}
                      onOverBarrier={v => set("recoveryOverBarrier", v)}
                      onUnderBarrier={v => set("recoveryUnderBarrier", v)}
                    />
                  )}

                  {/* Risk Management */}
                  <div className="space-y-2 pt-1 border-t border-white/5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Risk Parameters</p>
                    <div className="space-y-1.5">
                      <NumInput label="Base stake" value={config.stake} onChange={v => set("stake", v)} min={0.35} step={0.5} suffix="USD" />
                      <NumInput label="Take profit" value={config.takeProfit} onChange={v => set("takeProfit", v)} min={1} step={1} suffix="USD" />
                      <NumInput label="Stop loss" value={config.stopLoss} onChange={v => set("stopLoss", v)} min={1} step={1} suffix="USD" />
                    </div>
                  </div>

                  {/* Recovery Execution Policy */}
                  <div className="space-y-2 pt-1 border-t border-white/5">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Recovery Engine</p>
                      <span className="text-[9px] text-cyan-400 font-mono">Penny-Ceiling Math</span>
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        onClick={() => set("recoveryAutoMode", true)}
                        className={`py-1.5 px-2 rounded-lg text-xs border font-medium transition-all ${
                          config.recoveryAutoMode ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-300" : "bg-white/5 border-white/10 text-muted-foreground"
                        }`}
                      >
                        AI Exact Auto
                      </button>
                      <button
                        onClick={() => set("recoveryAutoMode", false)}
                        className={`py-1.5 px-2 rounded-lg text-xs border font-medium transition-all ${
                          !config.recoveryAutoMode ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-300" : "bg-white/5 border-white/10 text-muted-foreground"
                        }`}
                      >
                        Manual Multiplier
                      </button>
                    </div>

                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">Recovery Mode</span>
                        <div className="flex gap-1">
                          <button
                            onClick={() => set("recoveryMethod", "split")}
                            className={`px-2 py-1 rounded text-xs border ${config.recoveryMethod === "split" ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-300" : "bg-white/5 border-white/10 text-muted-foreground"}`}
                          >
                            Split (Safe)
                          </button>
                          <button
                            onClick={() => set("recoveryMethod", "instant")}
                            className={`px-2 py-1 rounded text-xs border ${config.recoveryMethod === "instant" ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-300" : "bg-white/5 border-white/10 text-muted-foreground"}`}
                          >
                            Instant (1-Win)
                          </button>
                        </div>
                      </div>

                      {!config.recoveryAutoMode && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground flex-1">Multiplier</span>
                          <div className="flex items-center gap-1">
                            <Input
                              type="number" value={config.recoveryMultiplier} step={0.01}
                              onChange={e => set("recoveryMultiplier", Number(e.target.value))}
                              className="w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10"
                            />
                            <span className="text-[10px] text-muted-foreground">×</span>
                          </div>
                        </div>
                      )}

                      <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => set("maxRecoverySteps", v)} min={1} max={10} />
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="space-y-2 pt-1">
                    <Button
                      onClick={handleScan}
                      disabled={loading}
                      className="w-full h-10 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-sm shadow-lg shadow-cyan-900/40"
                    >
                      <ScanSearch className="w-4 h-4 mr-2" />
                      Neural Scan All Markets
                    </Button>

                  </div>
                </div>
              )}

              {/* ── STEP: SCANNING ── */}
              {step === "scanning" && (
                <div className="p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <motion.div
                        className="w-5 h-5 rounded-full bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center"
                        animate={{ boxShadow: ["0 0 0px rgba(6,182,212,0)", "0 0 8px rgba(6,182,212,0.5)", "0 0 0px rgba(6,182,212,0)"] }}
                        transition={{ duration: 2, repeat: Infinity }}
                      >
                        <Loader2 className="w-3 h-3 text-cyan-400 animate-spin" />
                      </motion.div>
                      <div>
                        <p className="text-xs font-bold text-white tracking-wide leading-none">Quantum Neural Scan</p>
                        <p className="text-[9px] text-cyan-400/60 mt-0.5">Neural Scoring Active</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-bold font-mono text-cyan-400">
                        {scanProgress.scanning !== null ? scanProgress.scanned + 1 : scanProgress.scanned}
                      </span>
                      <span className="text-xs text-muted-foreground/40 font-mono"> / {scanProgress.total || SCAN_MARKET_COUNT}</span>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: "linear-gradient(90deg, #0891b2, #06b6d4, #67e8f9)" }}
                      animate={{ width: `${(scanProgress.scanned / (scanProgress.total || SCAN_MARKET_COUNT)) * 100}%` }}
                      transition={{ duration: 0.35, ease: "easeOut" }}
                    />
                  </div>

                  {/* Now analyzing indicator */}
                  <div className="relative rounded-xl border overflow-hidden flex items-center gap-3 px-3 py-3 bg-cyan-950/40 border-cyan-500/20">
                    <div className="relative w-8 h-8 flex-shrink-0">
                      <div className="absolute inset-0 rounded-full bg-cyan-500/10 border border-cyan-500/25 flex items-center justify-center">
                        <ScanSearch className="w-3.5 h-3.5 text-cyan-400" />
                      </div>
                    </div>
                    <div className="relative flex-1 min-w-0">
                      <p className="text-[9px] uppercase tracking-widest text-cyan-400/50 mb-0.5">Analyzing Asset</p>
                      <p className="text-sm font-bold text-white truncate">
                        {scanProgress.scanning ?? "Calibrating Bayesian prior…"}
                      </p>
                    </div>
                  </div>

                  {/* Live Results */}
                  {scanProgress.results.length > 0 && (
                    <div className="space-y-1 max-h-44 overflow-y-auto pr-0.5">
                      {[...scanProgress.results].sort((a, b) => b.score - a.score).map((r, i) => {
                        const market = ALL_SCAN_MARKETS.find(m => m.symbol === r.symbol);
                        const isLeading = i === 0;
                        return (
                          <div
                            key={r.symbol}
                            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs ${
                              isLeading ? "bg-cyan-500/10 border border-cyan-500/25 text-white" : "bg-white/3 text-white/70"
                            }`}
                          >
                            <span className="font-mono text-[10px] text-muted-foreground/40 w-4">{i + 1}</span>
                            <span className="font-medium flex-1 truncate">{market?.short ?? r.symbol}</span>
                            <span className={`font-mono font-bold ${scoreColor(r.score)}`}>{r.score.toFixed(0)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ── STEP: SCAN RESULT ── */}
              {step === "scan-result" && scanResult && (
                <div className="p-4 space-y-4">
                  {scanResult.suitable && scanResult.best ? (
                    <>
                      <div className="rounded-xl bg-green-500/5 border border-green-500/25 p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <CheckCircle2 className="w-4 h-4 text-green-400" />
                            <p className="text-xs font-semibold text-green-300">Statistical Edge Verified</p>
                          </div>
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-green-500/20 text-green-300">
                            +EV Positive
                          </span>
                        </div>

                        <div className="bg-black/30 rounded-lg p-2.5 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-bold text-white truncate">{scanResult.best.displayName}</p>
                            <span className={`text-sm font-bold font-mono ${scoreColor(scanResult.best.score)}`}>
                              {scanResult.best.score.toFixed(0)}<span className="text-[10px] font-normal text-muted-foreground">/100</span>
                            </span>
                          </div>

                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 font-mono font-medium">
                              {scanResult.best.contractType}{scanResult.best.barrier !== undefined ? ` ${scanResult.best.barrier}` : ""}
                            </span>
                            <span className="text-muted-foreground">{(scanResult.best.winProbability * 100).toFixed(1)}% win rate</span>
                          </div>

                          {/* Metric badges */}
                          <div className="grid grid-cols-3 gap-1.5 pt-1">
                            <div className="bg-white/5 rounded px-2 py-1 text-center">
                              <p className="text-[8px] text-muted-foreground/60 uppercase">Normal</p>
                              <span className="text-[11px] font-bold font-mono text-cyan-400">
                                {(scanResult.best.normalScore ?? 0).toFixed(0)}
                              </span>
                            </div>
                            <div className="bg-white/5 rounded px-2 py-1 text-center">
                              <p className="text-[8px] text-amber-400/60 uppercase">Sniper Rec</p>
                              <span className="text-[11px] font-bold font-mono text-amber-400">
                                {(scanResult.best.recoveryScore ?? 0).toFixed(0)}
                              </span>
                            </div>
                            <div className="bg-white/5 rounded px-2 py-1 text-center">
                              <p className="text-[8px] text-muted-foreground/60 uppercase">Entropy</p>
                              <span className="text-[11px] font-bold font-mono text-white">
                                {scanResult.best.entropyBits ? `${scanResult.best.entropyBits}b` : "3.10b"}
                              </span>
                            </div>
                          </div>

                          <p className="text-[10px] text-muted-foreground">{scanResult.best.reason}</p>
                        </div>
                      </div>

                      {/* Execution Mode Buttons */}
                      <div className="space-y-2">
                        <Button
                          onClick={() => handleStart(scanResult.best!.symbol, "locked")}
                          disabled={loading}
                          className="w-full h-10 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-xs shadow-lg shadow-cyan-900/40"
                        >
                          <Lock className="w-3.5 h-3.5 mr-2" />
                          Trade Locked on {scanResult.best.displayName}
                        </Button>

                        <Button
                          onClick={() => handleStart(undefined, "switching")}
                          disabled={loading}
                          variant="outline"
                          className="w-full h-9 border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 text-xs font-semibold"
                        >
                          <Shuffle className="w-3.5 h-3.5 mr-2" />
                          Trade with Smart Market Switching
                        </Button>
                      </div>

                      <button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1">
                        ← Change settings
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                          <p className="text-xs font-semibold text-amber-300">No Decisive Edge Found</p>
                        </div>
                        <p className="text-[11px] text-muted-foreground">{scanResult.reason}</p>
                      </div>

                      <Button onClick={handleScan} disabled={loading} className="w-full h-10 bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs">
                        <RefreshCw className="w-3.5 h-3.5 mr-2" />
                        Re-Scan Markets
                      </Button>

                      <button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1">
                        ← Change settings
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* ── STEP: RUNNING ── */}
              {step === "running" && (
                <div className="p-4 space-y-4">
                  {/* P&L card */}
                  <div className={`rounded-xl p-3 border ${isRunning ? "bg-cyan-500/5 border-cyan-500/20" : "bg-secondary/30 border-border"}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&L</span>
                      {isRunning ? (
                        <span className="flex items-center gap-1 text-[10px] text-cyan-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                          LIVE 1-TICK
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">STOPPED</span>
                      )}
                    </div>
                    <div className={`text-2xl font-bold font-mono ${profitColor}`}>
                      {(status?.totalProfit ?? 0) >= 0 ? "+" : ""}${Math.abs(status?.totalProfit ?? 0).toFixed(2)}
                    </div>
                    <div className="flex gap-3 mt-2 text-[11px]">
                      <span className="text-green-400">{status?.winCount ?? 0}W</span>
                      <span className="text-red-400">{status?.lossCount ?? 0}L</span>
                      <span className="text-muted-foreground">{winRate}% WR</span>
                      <span className="text-muted-foreground">{status?.tradeCount ?? 0} trades</span>
                    </div>

                    {status?.config && (
                      <div className="mt-2 space-y-1">
                        <div className="flex justify-between text-[9px] text-muted-foreground">
                          <span>SL -${status.config.stopLoss.toFixed(2)}</span>
                          <span>TP +${status.config.takeProfit.toFixed(2)}</span>
                        </div>
                        <div className="h-1.5 bg-secondary rounded-full overflow-hidden relative">
                          <div className="absolute left-1/2 top-0 w-px h-full bg-white/20" />
                          <div
                            className={`absolute top-0 h-full rounded-full transition-all ${status.totalProfit >= 0 ? "bg-green-500 left-1/2" : "bg-red-500 right-1/2"}`}
                            style={{ width: `${Math.min(50, Math.abs(status.totalProfit) / (status.totalProfit >= 0 ? status.config.takeProfit : status.config.stopLoss) * 50)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Status message */}
                  {status?.message && (
                    <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                      status.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" :
                      status.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400" :
                      status.message.startsWith("🎯") ? "bg-amber-500/10 border-amber-500/25 text-amber-300" :
                      "bg-secondary/30 border-border text-muted-foreground"
                    }`}>
                      {status.message}
                    </div>
                  )}

                  {/* Active Market & Contract */}
                  {isRunning && status?.currentMarket && (
                    <div className="flex items-center gap-2 bg-white/3 rounded-lg px-3 py-2 border border-white/5">
                      <Loader2 className="w-3 h-3 text-cyan-400 animate-spin flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 inline-block" />
                          Active Asset
                        </p>
                        <p className="text-xs font-semibold text-white truncate">{status.currentMarket}</p>
                        <p className="text-[10px] font-mono text-cyan-400">{status.currentContractType} · ${status.currentStake.toFixed(2)}</p>
                      </div>
                      {status.lastResult && (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${status.lastResult === "won" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                          {status.lastResult.toUpperCase()}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Recovery Status */}
                  {status?.inRecovery && (
                    <div className="rounded-lg px-3 py-2 border text-xs bg-amber-500/8 border-amber-500/30 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                          <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                          Sniper Recovery Active (Step {status.recoveryStep})
                        </span>
                        <span className="font-mono text-[10px] text-amber-400">
                          ${status.unrecoveredAmount.toFixed(2)} debt
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Optional sizing target +${(status.recoveryRemainingTargetProfit ?? status.recoveryTargetProfit ?? 0).toFixed(2)} — recovery exits when debt is cleared.
                      </p>
                    </div>
                  )}

                  {/* Controls */}
                  <div className="flex gap-2">
                    {isRunning ? (
                      <Button onClick={handleStop} disabled={loading} variant="destructive" className="flex-1 h-9 text-xs">
                        <StopCircle className="w-3.5 h-3.5 mr-1.5" />
                        Stop NeuroAI
                      </Button>
                    ) : (
                      <>
                        <Button onClick={handleReset} variant="outline" className="flex-1 h-9 text-xs border-white/10">
                          New Session
                        </Button>
                        <Button onClick={handleScan} disabled={loading} className="flex-1 h-9 text-xs bg-cyan-600 hover:bg-cyan-500 text-white font-bold">
                          <ScanSearch className="w-3.5 h-3.5 mr-1.5" />
                          Re-Scan
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* FAB Trigger Button */}
      <motion.button
        onClick={() => setOpen(o => !o)}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
        className="fixed bottom-5 right-5 z-50"
        aria-label="NeuroAI Engine"
      >
        <div
          className="absolute pointer-events-none"
          style={{
            inset: "-1.5px",
            borderRadius: "20px",
            border: "1px solid rgba(34,211,238,0.15)",
          }}
        />

        <motion.div
          className="absolute pointer-events-none"
          style={{
            inset: "-1.5px",
            borderRadius: "20px",
            padding: "1.5px",
            background: isRunning
              ? "conic-gradient(from 0deg, transparent 0%, transparent 50%, rgba(34,211,238,0.2) 65%, rgba(34,211,238,1) 78%, rgba(167,243,208,1) 82%, rgba(34,211,238,1) 86%, rgba(34,211,238,0.2) 98%, transparent 100%)"
              : "conic-gradient(from 0deg, transparent 0%, transparent 60%, rgba(34,211,238,0.1) 72%, rgba(34,211,238,0.85) 80%, rgba(167,243,208,0.95) 83%, rgba(34,211,238,0.85) 86%, rgba(34,211,238,0.1) 95%, transparent 100%)",
            WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
            WebkitMaskComposite: "destination-out",
            maskComposite: "exclude",
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: isRunning ? 1.8 : 3.5, repeat: Infinity, ease: "linear" }}
        />

        <motion.div
          className="absolute inset-0 rounded-[18px] pointer-events-none"
          animate={{
            boxShadow: isRunning
              ? ["0 0 18px 2px rgba(6,182,212,0.5)", "0 0 32px 6px rgba(6,182,212,0.75)", "0 0 18px 2px rgba(6,182,212,0.5)"]
              : ["0 0 10px 0px rgba(6,182,212,0.15)", "0 0 20px 3px rgba(6,182,212,0.32)", "0 0 10px 0px rgba(6,182,212,0.15)"],
          }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        />

        {isRunning && (
          <motion.span
            className="absolute inset-0 rounded-[18px] border border-cyan-400/40 pointer-events-none"
            animate={{ scale: [1, 1.35], opacity: [0.6, 0] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
          />
        )}

        <div className={`
          relative w-14 h-14 rounded-[18px] flex flex-col items-center justify-center gap-0.5
          transition-all duration-300
          ${isRunning
            ? "bg-gradient-to-br from-cyan-500 to-blue-600"
            : "bg-gradient-to-br from-[#0d1a2d] to-[#0a1525]"}
        `}>
          <div className="absolute inset-0 rounded-[18px] bg-gradient-to-tr from-white/8 to-transparent pointer-events-none" />
          <img
            src="/neuroai-logo.png"
            alt=""
            aria-hidden="true"
            className="w-5 h-5 object-contain drop-shadow-sm"
          />
          <span className={`text-[7px] font-bold tracking-wider ${isRunning ? "text-white/90" : "text-cyan-400/90"}`}>
            {isRunning ? "LIVE" : "NEUROAI"}
          </span>
          {isRunning && status && status.tradeCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-cyan-400 text-[8px] font-bold text-black flex items-center justify-center">
              {status.tradeCount}
            </span>
          )}
        </div>
      </motion.button>
    </>
  );
}
