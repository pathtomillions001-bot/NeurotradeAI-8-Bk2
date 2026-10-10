import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useExecuteTrade, useGetSettings } from "@workspace/api-client-react";
import { toast } from "sonner";
import { Zap, TrendingUp, TrendingDown, ChevronDown, ChevronUp } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

// ── Contract type groups ────────────────────────────────────────────────────────
const CONTRACT_GROUPS = [
  { label: "Rise / Fall",  short: "R/F", types: ["CALL", "PUT"] },
  { label: "Over / Under", short: "O/U", types: ["DIGITOVER", "DIGITUNDER"] },
  { label: "Even / Odd",   short: "E/O", types: ["DIGITEVEN", "DIGITODD"] },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatContractLabel(contractType?: string, barrier?: number | null): string {
  if (!contractType) return "—";
  if (contractType === "DIGITOVER")  return barrier != null ? `OVER ${barrier}` : "OVER";
  if (contractType === "DIGITUNDER") return barrier != null ? `UNDER ${barrier}` : "UNDER";
  if (contractType === "DIGITEVEN")  return "EVEN";
  if (contractType === "DIGITODD")   return "ODD";
  if (contractType === "CALL")       return "RISE";
  if (contractType === "PUT")        return "FALL";
  return contractType;
}

function contractToDirection(ct: string): "up" | "down" {
  if (ct === "CALL" || ct === "RISE" || ct === "DIGITOVER" || ct === "DIGITEVEN") return "up";
  return "down";
}

function contractColor(ct: string): string {
  if (ct === "CALL" || ct === "RISE") return "#10b981";
  if (ct === "PUT"  || ct === "FALL") return "#ef4444";
  if (ct === "DIGITOVER")             return "#06b6d4";
  if (ct === "DIGITUNDER")            return "#f59e0b";
  if (ct === "DIGITEVEN")             return "#8b5cf6";
  if (ct === "DIGITODD")              return "#ec4899";
  return "#00ffff";
}

// ── FlashCard3D kept for compatibility ────────────────────────────────────────
export function FlashCard3D({ front }: { front: React.ReactNode; back?: React.ReactNode; flipped?: boolean; onFlip?: () => void; className?: string; glowColor?: string }) {
  return <div className="w-full h-full">{front}</div>;
}

// ── Win probability bar ────────────────────────────────────────────────────────
function WinProbBar({ value }: { value: number }) {
  const color = value >= 65 ? "#10b981" : value >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex flex-col items-center gap-0.5 w-14">
      <div className="text-xs font-mono font-bold" style={{ color }}>{value.toFixed(0)}%</div>
      <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.min(value, 100)}%`, background: color }}
        />
      </div>
      <div className="text-[8px] font-mono text-muted-foreground">WIN PROB</div>
    </div>
  );
}

// ── Quick Strike Card ──────────────────────────────────────────────────────────
export function MarketOpportunityFlashCard({
  onTrade,
}: {
  onTrade?: () => void;
  currentStreak?: number;
}) {
  const [selectedGroupIdx, setSelectedGroupIdx] = useState(0);
  const [executingSymbol, setExecutingSymbol] = useState<string | null>(null);
  const [showMarkets, setShowMarkets] = useState(false);

  const executeTrade = useExecuteTrade();

  // Read user's enabled contract families from settings
  const { data: settings } = useGetSettings();
  const preferredTypes: string[] = (settings as any)?.preferredContractTypes ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];

  // Only show tabs for enabled groups; fall back to all groups if nothing is active
  const enabledGroups = CONTRACT_GROUPS.filter(g =>
    (g.types as readonly string[]).some(t => preferredTypes.includes(t))
  );
  const visibleGroups = enabledGroups.length > 0 ? enabledGroups : [...CONTRACT_GROUPS];

  // Auto-reset selectedGroupIdx when enabled groups change (e.g. user disables Rise/Fall)
  const clampedIdx = Math.min(selectedGroupIdx, visibleGroups.length - 1);

  const selectedGroup = visibleGroups[clampedIdx];
  const effectiveGroupIdx = CONTRACT_GROUPS.findIndex(g => g.short === selectedGroup.short);

  // All markets ranked by quality score from background scanner
  const { data: allMarkets } = useQuery<any[]>({
    queryKey: ["markets", "ranked-all"],
    queryFn: () => fetch("/api/markets?limit=50").then(r => r.json()),
    refetchInterval: 8000,
  });

  // Filter to markets whose AI-recommended contract type is in the selected group
  const groupMarkets = (allMarkets ?? []).filter((m: any) =>
    (selectedGroup.types as readonly string[]).includes(m.recommendedContractType)
  );
  const tradeableGroupMarkets = groupMarkets.filter((m: any) => m.shouldTrade);

  // Best market: tradeable first, then highest quality score
  const bestGroupMarket = tradeableGroupMarkets[0] ?? groupMarkets[0] ?? allMarkets?.[0];

  // Fetch full recommendation for the selected market (AI-configured ticks, stake, barrier)
  const { data: marketDetail } = useQuery<any>({
    queryKey: ["market-detail-flash", bestGroupMarket?.symbol, effectiveGroupIdx],
    queryFn: () => bestGroupMarket?.symbol
      ? fetch(`/api/markets/${bestGroupMarket.symbol}`).then(r => r.json())
      : Promise.resolve(null),
    refetchInterval: 8000,
    enabled: !!bestGroupMarket?.symbol,
  });

  const rec = marketDetail?.recommendation;

  // Contract type from AI recommendation, clamped to the selected group
  const recContractType: string = rec?.contractType ?? bestGroupMarket?.recommendedContractType ?? selectedGroup.types[0];
  const contractType = (selectedGroup.types as readonly string[]).includes(recContractType)
    ? recContractType
    : selectedGroup.types[0];

  // Barrier from AI recommendation
  const activeBarrier = contractType.includes("DIGIT") && rec?.digitBarrier != null
    ? rec.digitBarrier
    : undefined;

  const ctColor = contractColor(contractType);
  const isUp = contractToDirection(contractType) === "up";

  // Execute is active when there is a recommendation for the selected group
  const isGroupMatch = (selectedGroup.types as readonly string[]).includes(
    rec?.contractType ?? bestGroupMarket?.recommendedContractType ?? ""
  );
  const shouldTrade = isGroupMatch && !!rec;

  const winProb = rec?.winProbability ?? rec?.confidence ?? 0;
  const isExecuting = executingSymbol === bestGroupMarket?.symbol;

  const handleExecute = () => {
    if (!bestGroupMarket || !rec) return;

    const sym = bestGroupMarket.symbol;
    const stake = rec?.stake ?? 1;
    setExecutingSymbol(sym);

    executeTrade.mutate({
      data: {
        symbol: sym,
        contractType,
        stake,
        direction: contractToDirection(contractType),
        ...(activeBarrier != null && { barrier: activeBarrier }),
        duration: rec?.recommendedDuration ?? 5,
        durationUnit: "t",
      } as any
    }, {
      onSuccess: (trade: any) => {
        const won = trade.status === "won";
        toast[won ? "success" : "error"](
          `${won ? "✓ Won" : "✗ Lost"} $${Math.abs(Number(trade.profit ?? 0)).toFixed(2)} on ${bestGroupMarket.displayName}`
        );
        setExecutingSymbol(null);
        onTrade?.();
      },
      onError: () => {
        toast.error("Trade failed — check account settings");
        setExecutingSymbol(null);
      }
    });
  };

  return (
    <div
      className="relative w-full h-full rounded-2xl border overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #18181b 0%, #18181b 50%, #0f0f10 100%)",
        borderColor: "rgba(0,255,255,0.2)",
        boxShadow: `0 0 30px ${ctColor}30, 0 0 60px ${ctColor}10, inset 0 1px 0 rgba(255,255,255,0.05)`,
      }}
    >
      {/* Corner accents */}
      <span className="absolute top-0 left-0 w-5 h-5 border-t-2 border-l-2 border-primary rounded-tl-2xl" />
      <span className="absolute top-0 right-0 w-5 h-5 border-t-2 border-r-2 border-primary rounded-tr-2xl" />
      <span className="absolute bottom-0 left-0 w-5 h-5 border-b-2 border-l-2 border-primary rounded-bl-2xl" />
      <span className="absolute bottom-0 right-0 w-5 h-5 border-b-2 border-r-2 border-primary rounded-br-2xl" />

      {/* Scan line */}
      <motion.div
        className="absolute inset-x-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, rgba(0,255,255,0.5), transparent)" }}
        animate={{ top: ["0%", "100%", "0%"] }}
        transition={{ duration: 4, ease: "linear", repeat: Infinity }}
      />

      {/* Grid overlay */}
      <div className="absolute inset-0 opacity-[0.025]" style={{
        backgroundImage: `linear-gradient(rgba(0,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,255,1) 1px, transparent 1px)`,
        backgroundSize: "20px 20px"
      }} />

      <div className="relative z-10 p-4 flex flex-col gap-3 h-full">
        {/* Header: label + contract group selector + live dot */}
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: "rgba(0,255,255,0.7)" }}>
            Quick Strike
          </span>

          {/* Contract group tab selector — only shows enabled families */}
          {visibleGroups.length > 0 && (
            <div className="ml-auto flex items-center bg-black/40 rounded-lg p-0.5 gap-0.5">
              {visibleGroups.map((g, i) => (
                <button
                  key={g.short}
                  onClick={() => { setSelectedGroupIdx(i); setShowMarkets(false); }}
                  className={`text-[8px] font-mono font-bold px-2 py-1 rounded transition-all ${
                    i === clampedIdx
                      ? "text-primary border border-primary/50"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  style={i === clampedIdx ? { background: `${contractColor(g.types[0])}20` } : {}}
                >
                  {g.short}
                </button>
              ))}
            </div>
          )}

          <span className="w-1.5 h-1.5 rounded-full animate-pulse ml-1 bg-green-500" />
        </div>

        {/* Market info + win prob + execute */}
        <div className="flex items-center gap-2">
          {/* Left: market name + contract badge */}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold leading-tight truncate">{bestGroupMarket?.displayName ?? "Scanning…"}</div>
            <div className="text-[10px] font-mono text-muted-foreground">{bestGroupMarket?.symbol ?? "—"}</div>
            <div className="mt-2 flex items-center gap-1.5">
              {isUp
                ? <TrendingUp className="w-3 h-3 shrink-0" style={{ color: ctColor }} />
                : <TrendingDown className="w-3 h-3 shrink-0" style={{ color: ctColor }} />}
              <span
                className="text-sm font-mono font-bold px-2 py-0.5 rounded-full border"
                style={{ color: ctColor, borderColor: `${ctColor}50`, background: `${ctColor}15` }}
              >
                {formatContractLabel(contractType, activeBarrier ?? rec?.digitBarrier ?? rec?.barrier)}
              </span>
              <span className="text-[9px] text-muted-foreground font-mono capitalize truncate">
                {(bestGroupMarket?.regime ?? marketDetail?.regime ?? "").replace(/_/g, " ")}
              </span>
            </div>
          </div>

          {/* Center: win probability */}
          <WinProbBar value={Math.round(winProb * (winProb > 1 ? 1 : 100))} />

          {/* Right: execute button */}
          <div className="shrink-0">
            <button
              onClick={handleExecute}
              disabled={!shouldTrade || isExecuting}
              className="flex flex-row items-center justify-center gap-1.5 h-10 px-4 rounded-xl border-2 font-bold font-mono text-[10px] transition-all active:scale-[0.95] disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                minWidth: "96px",
                ...(shouldTrade ? {
                  borderColor: ctColor,
                  background: `${ctColor}20`,
                  color: ctColor,
                  boxShadow: `0 0 20px ${ctColor}30`,
                } : {
                  borderColor: "rgba(255,255,255,0.1)",
                  color: "rgba(255,255,255,0.3)",
                }),
              }}
            >
              {isExecuting ? (
                <span className="text-[9px] uppercase tracking-wide">EXEC…</span>
              ) : shouldTrade ? (
                <>
                  <span className="text-sm leading-none">⚡</span>
                  <span className="text-[9px] uppercase tracking-widest">Execute</span>
                </>
              ) : (
                <>
                  <span className="text-sm leading-none">⏸</span>
                  <span className="text-[9px] uppercase tracking-widest">Wait</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Stats row: EV | Ticks | Stake */}
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { label: "EV",    value: rec ? (rec.expectedValue > 0 ? `+$${rec.expectedValue.toFixed(2)}` : `$${rec.expectedValue?.toFixed(2) ?? "—"}`) : "—" },
            { label: "Ticks", value: rec ? `${rec.recommendedDuration ?? 5}t` : "—" },
            { label: "Stake", value: rec ? `$${(rec.stake ?? 1).toFixed(2)}` : "—" },
          ].map(({ label, value }) => (
            <div key={label} className="text-center p-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
              <div className="text-[8px] text-muted-foreground uppercase tracking-wide">{label}</div>
              <div className="text-[11px] font-mono font-bold mt-0.5">{value}</div>
            </div>
          ))}
        </div>

        {/* Footer: count + expand */}
        <div className="flex items-center justify-between mt-auto">
          <span className="text-[9px] font-mono text-muted-foreground">
            {allMarkets?.length ?? 0} markets scanned &middot; {tradeableGroupMarkets.length} tradeable in {selectedGroup.short}
          </span>
          {groupMarkets.length > 1 && (
            <button
              onClick={() => setShowMarkets(s => !s)}
              className="flex items-center gap-1 text-[9px] font-mono text-primary/50 hover:text-primary transition-colors"
            >
              Top {Math.min(groupMarkets.length, 5)} {showMarkets ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>

        {/* Expandable group market list */}
        <AnimatePresence>
          {showMarkets && groupMarkets.length > 1 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="space-y-1 pt-1 border-t border-white/[0.07]">
                {groupMarkets.slice(0, 5).map((market: any, idx: number) => {
                  const ct = market.recommendedContractType ?? selectedGroup.types[0];
                  const ctCol = contractColor(ct);
                  const isExec = executingSymbol === market.symbol;
                  const hasSignal = market.shouldTrade && (selectedGroup.types as readonly string[]).includes(ct);
                  return (
                    <div key={market.symbol} className="flex items-center gap-2 py-1">
                      <span className="text-[9px] font-mono text-muted-foreground w-4 text-center">{idx + 1}</span>
                      <span className="flex-1 text-[10px] font-medium truncate">{market.displayName}</span>
                      <span
                        className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded border"
                        style={{ color: ctCol, borderColor: `${ctCol}40`, background: `${ctCol}10` }}
                      >
                        {formatContractLabel(ct)}
                      </span>
                      <span className="text-[9px] font-mono text-muted-foreground w-8 text-right">
                        {market.confidenceScore?.toFixed(0) ?? 0}%
                      </span>
                      <button
                        onClick={() => {
                          if (!hasSignal) return;
                          const sym = market.symbol;
                          setExecutingSymbol(sym);
                          executeTrade.mutate({
                            data: {
                              symbol: sym, contractType: ct,
                              stake: rec?.stake ?? 1,
                              direction: contractToDirection(ct),
                              duration: rec?.recommendedDuration ?? 5,
                              durationUnit: "t",
                            } as any
                          }, {
                            onSuccess: (trade: any) => {
                              const won = trade.status === "won";
                              toast[won ? "success" : "error"](`${won ? "✓ Won" : "✗ Lost"} on ${market.displayName}`);
                              setExecutingSymbol(null);
                            },
                            onError: () => { toast.error("Trade failed"); setExecutingSymbol(null); }
                          });
                        }}
                        disabled={isExec || !hasSignal}
                        title={!hasSignal ? "No active signal for this market" : undefined}
                        className="px-2 py-0.5 rounded text-[8px] font-bold font-mono border transition-all active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed"
                        style={hasSignal ? { background: `${ctCol}15`, borderColor: `${ctCol}50`, color: ctCol } : { background: "transparent", borderColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.25)" }}
                      >
                        {isExec ? "…" : hasSignal ? "⚡" : "⏸"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
