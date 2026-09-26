import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Loader2, ScanSearch, Workflow, X } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ACCENTS, BOT_ICON, type BotCardData, type BotSessionStatus } from "@/lib/bots";
import { loadStrategyIntoBotBuilder } from "@/lib/bot-builder-frame";
import { withTabSession } from "@/lib/tab-session";

type Candidate = {
  symbol: string; displayName: string; favoredSide: "over4" | "under5"; score: number;
  samples: number; effectiveSamples: number; overProbability: number; underProbability: number;
  edgeMagnitude: number; edgeLowerBound: number; zScore: number; markovProbability: number;
  stationarityZ: number; chiSquare: number; entropy: number; confidence: string;
  suitable: boolean; reason: string;
};
type Result = { suitable: boolean; best: Candidate | null; allScored: Candidate[]; reason: string; invariant: string };

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

export function PairedEdgeConsole({ bot, open, onOpenChange }: {
  bot: BotCardData; open: boolean; onOpenChange: (v: boolean) => void;
  session: BotSessionStatus | null; onSession: (s: BotSessionStatus | null) => void;
}) {
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Workflow;
  const [, navigate] = useLocation();
  const [result, setResult] = useState<Result | null>(null);
  const [scanning, setScanning] = useState(false);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState({ name: "", done: 0, total: 20 });
  const [config, setConfig] = useState({ stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3 });

  useEffect(() => {
    if (!open) return;
    const es = new EventSource(withTabSession("/api/ai/events"));
    es.addEventListener("bot_scan_progress", event => {
      try {
        const p = JSON.parse((event as MessageEvent).data);
        if (p.botId === "paired-edge") setProgress({ name: p.scanning ?? "", done: p.scanned, total: p.total });
      } catch { /* noop */ }
    });
    return () => es.close();
  }, [open]);

  const scan = async () => {
    setScanning(true); setResult(null); setProgress({ name: "", done: 0, total: 20 });
    try {
      const response = await fetch("/api/bots/paired-edge/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Scan failed");
      setResult(data);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Scan failed"); }
    finally { setScanning(false); }
  };

  const create = async () => {
    if (!result?.best) return;
    setBuilding(true);
    try {
      const response = await fetch("/api/bots/paired-edge/dbot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: result.best.symbol, ...config }),
      });
      const data = await response.json();
      if (!response.ok || !data.xml) throw new Error(data.error ?? "Could not build DBot");
      const loaded = loadStrategyIntoBotBuilder({ name: data.name, xml: data.xml, symbol: result.best.symbol });
      onOpenChange(false); navigate("/bot-builder");
      if (await loaded) toast.success("Paired DBot loaded. Verify the two-rail blocks, connect your account, then press Run.", { duration: 12000 });
      else toast.error("Bot Builder did not confirm the paired strategy loaded.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not create DBot"); }
    finally { setBuilding(false); }
  };

  return <AnimatePresence>{open && <>
    <motion.div className="fixed inset-0 z-40 bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => onOpenChange(false)} />
    <motion.div role="dialog" aria-label="Paired Edge Architect" className={`fixed bottom-20 right-4 z-50 w-[390px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl`} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}>
      <header className={`p-4 border-b border-white/5 bg-gradient-to-r ${a.headerGrad} flex items-center gap-3`}>
        <span className={`w-9 h-9 rounded-xl ${a.iconBg} flex items-center justify-center`}><Icon className={`w-4 h-4 ${a.text}`} /></span>
        <div className="min-w-0 flex-1"><h3 className="text-sm font-bold">{bot.name}</h3><p className="text-[10px] text-muted-foreground">{bot.tagline}</p></div>
        <button onClick={() => onOpenChange(false)}><X className="w-4 h-4" /></button>
      </header>
      <div className="p-4 space-y-4">
        <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-3 text-[10px] text-muted-foreground leading-relaxed">
          <b className="text-violet-200">Mathematical invariant:</b> synchronized Over 4 and Under 5 partition digits 0–9, so one always wins. “Recovery” starts only if the <b>combined realised basket P&amp;L</b> is negative. The bot never invents a $2 loss. If the two broker contracts do not close on the same exit tick, it halts.
        </div>

        <div className="grid grid-cols-2 gap-2">
          {([['stake','Stake / rail',0.35],['takeProfit','Take profit',1],['stopLoss','Stop loss',1],['maxRecoverySteps','Recovery steps',1]] as const).map(([key,label,min]) => <label key={key} className="text-[9px] text-muted-foreground">{label}<Input type="number" min={min} step={key === 'stake' ? .05 : 1} value={config[key]} onChange={e => setConfig(c => ({ ...c, [key]: Number(e.target.value) }))} className="mt-1 h-8 bg-black/30 font-mono text-xs" /></label>)}
        </div>

        <Button onClick={scan} disabled={scanning || building} className={`w-full ${a.solidBtn} text-white`}>
          {scanning ? <Loader2 className="mr-2 w-4 h-4 animate-spin" /> : <ScanSearch className="mr-2 w-4 h-4" />}
          {scanning ? `Scanning ${progress.name || "markets"} · ${progress.done}/${progress.total}` : "Scan for the Strongest Side"}
        </Button>

        {result?.best && <div className={`rounded-xl border p-3 space-y-3 ${result.suitable ? "border-green-500/30 bg-green-500/5" : "border-amber-500/30 bg-amber-500/5"}`}>
          <div className="flex items-start gap-2">{result.suitable ? <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5" /> : <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5" />}<div><p className="text-sm font-bold">{result.best.displayName}</p><p className={`text-xs font-semibold ${a.text}`}>{result.best.favoredSide === "over4" ? "Over 4" : "Under 5"} has the stronger measured side</p></div></div>
          <div className="grid grid-cols-3 gap-1.5 text-center">
            <Stat label="Over 4" value={pct(result.best.overProbability)} />
            <Stat label="Under 5" value={pct(result.best.underProbability)} />
            <Stat label="95% edge floor" value={pct(result.best.edgeLowerBound)} />
            <Stat label="Evidence z" value={result.best.zScore.toFixed(2)} />
            <Stat label="Markov read" value={pct(result.best.markovProbability)} />
            <Stat label="Drift z" value={result.best.stationarityZ.toFixed(2)} />
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">{result.best.reason}</p>
          {result.suitable ? <Button data-testid="paired-create-dbot" onClick={create} disabled={building} className="w-full bg-gradient-to-r from-fuchsia-600 to-violet-600 text-white font-bold">
            {building ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Workflow className="w-4 h-4 mr-2" />}{building ? "Building Paired DBot…" : "Create DBot"}
          </Button> : <p className="text-[10px] text-amber-200">No statistically defensible edge is available now. Re-scan later; the app will not create a strategy from noise.</p>}
        </div>}
      </div>
    </motion.div>
  </>}</AnimatePresence>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-black/25 px-1.5 py-2"><p className="text-[7px] uppercase text-muted-foreground">{label}</p><p className="text-[11px] font-mono font-bold">{value}</p></div>;
}
