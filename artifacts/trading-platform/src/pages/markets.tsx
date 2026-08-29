import { useState, useEffect, useRef } from "react";
import { useGetMarkets } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { TrendingUp, TrendingDown, Minus, ChevronRight, Zap } from "lucide-react";

type SubCategory = "all" | "volatility_1s" | "volatility" | "jump";

const SUBCATEGORIES: { key: SubCategory; label: string }[] = [
  { key: "all", label: "All Synthetics" },
  { key: "volatility_1s", label: "Volatility 1s" },
  { key: "volatility", label: "Volatility" },
  { key: "jump", label: "Jump Indices" },
];

function TrendIcon({ trend }: { trend: string }) {
  if (trend.includes("up")) return <TrendingUp className="w-3.5 h-3.5 text-green-500" />;
  if (trend.includes("down")) return <TrendingDown className="w-3.5 h-3.5 text-red-500" />;
  return <Minus className="w-3.5 h-3.5 text-zinc-500" />;
}

function ScoreBar({ value }: { value: number }) {
  const color = value >= 70 ? "bg-green-500" : value >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="text-sm font-mono w-8 text-right">{value.toFixed(0)}</div>
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function subCategoryFilter(symbol: string, sub: SubCategory): boolean {
  if (sub === "all") return true;
  if (sub === "volatility_1s") return symbol.startsWith("1HZ");
  if (sub === "volatility") return symbol.startsWith("R_") || symbol === "RDBULL" || symbol === "RDBEAR";
  if (sub === "jump") return symbol.startsWith("JD");
  return true;
}

export default function Markets() {
  const [subcat, setSubcat] = useState<SubCategory>("all");
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [tickCount, setTickCount] = useState(0);

  const { data: markets, isLoading, refetch } = useGetMarkets(
    { category: "synthetic" },
    { query: { refetchInterval: 5000 } } as { query: any }
  );

  // Live tick counter for UI freshness indicator
  useEffect(() => {
    tickerRef.current = setInterval(() => {
      setTickCount((c) => c + 1);
      refetch();
    }, 3000);
    return () => { if (tickerRef.current) clearInterval(tickerRef.current); };
  }, [refetch]);

  const filtered = (markets ?? []).filter((m) => subCategoryFilter(m.symbol, subcat));

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Synthetic Markets</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {filtered.length} markets ranked live — Deriv Synthetic Indices only
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
          <span className="text-muted-foreground font-mono">LIVE</span>
          {isLoading && <span className="text-primary animate-pulse">Scanning…</span>}
        </div>
      </div>

      {/* Sub-category tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {SUBCATEGORIES.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setSubcat(cat.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ${
              subcat === cat.key
                ? "bg-primary/20 text-primary border-primary/40"
                : "bg-secondary/50 text-muted-foreground border-border hover:text-foreground"
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Column headers */}
      <div className="hidden md:grid grid-cols-12 gap-3 px-4 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
        <div className="col-span-1">#</div>
        <div className="col-span-3">Market</div>
        <div className="col-span-2">Contract</div>
        <div className="col-span-2">Quality</div>
        <div className="col-span-2">Confidence</div>
        <div className="col-span-1">Risk</div>
        <div className="col-span-1"></div>
      </div>

      {/* Market rows */}
      <div className="space-y-1.5">
        {isLoading && filtered.length === 0 &&
          Array(8).fill(0).map((_, i) => (
            <div key={i} className="h-14 bg-secondary/30 rounded-lg animate-pulse" />
          ))
        }
        {filtered.map((market, idx) => (
          <Link key={market.symbol} href={`/markets/${market.symbol}`}>
            <motion.div
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.03 }}
              className="grid grid-cols-12 gap-3 items-center px-4 py-3 bg-card rounded-lg border border-border hover:border-primary/40 hover:bg-card/80 cursor-pointer transition-all group"
            >
              {/* Rank */}
              <div className="col-span-1 text-xs text-muted-foreground font-mono">
                {idx + 1}
              </div>

              {/* Name */}
              <div className="col-span-5 md:col-span-3 min-w-0">
                <div className="flex items-center gap-2">
                  <TrendIcon trend={market.trend} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{market.displayName}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-muted-foreground font-mono">{market.symbol}</span>
                      {market.lastPrice && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {market.lastPrice.toFixed(market.symbol.includes("1HZ100") || market.symbol.includes("R_100") ? 2 : 3)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Contract type */}
              <div className="col-span-3 md:col-span-2">
                <Badge
                  variant="outline"
                  className={`text-[10px] px-1.5 py-0 font-mono ${
                    market.recommendedContractType?.includes("RISE") || market.recommendedContractType?.includes("CALL")
                      ? "text-green-400 border-green-500/30"
                      : market.recommendedContractType?.includes("FALL") || market.recommendedContractType?.includes("PUT")
                      ? "text-red-400 border-red-500/30"
                      : "text-amber-400 border-amber-500/30"
                  }`}
                >
                  {market.recommendedContractType ?? "—"}
                </Badge>
              </div>

              {/* Quality */}
              <div className="hidden md:block col-span-2">
                <ScoreBar value={market.qualityScore ?? 0} />
              </div>

              {/* Confidence */}
              <div className="hidden md:block col-span-2">
                <ScoreBar value={market.confidenceScore ?? 0} />
              </div>

              {/* Risk */}
              <div className="hidden md:block col-span-1">
                <span className={`text-xs font-mono ${(market.riskScore ?? 0) > 60 ? "text-red-400" : (market.riskScore ?? 0) > 40 ? "text-amber-400" : "text-green-400"}`}>
                  {market.riskScore ?? 0}
                </span>
              </div>

              {/* Mobile: scores inline */}
              <div className="col-span-1 md:hidden flex flex-col items-end gap-0.5">
                <span className={`text-xs font-mono ${(market.qualityScore ?? 0) >= 70 ? "text-green-400" : "text-amber-400"}`}>{market.qualityScore ?? 0}</span>
              </div>

              {/* Chevron */}
              <div className="hidden md:flex col-span-1 justify-end">
                <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
            </motion.div>
          </Link>
        ))}
      </div>

      {filtered.length === 0 && !isLoading && (
        <div className="text-center py-12 text-muted-foreground">
          <Zap className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No markets found. Engine is scanning…</p>
        </div>
      )}
    </motion.div>
  );
}
