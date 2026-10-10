import { RefreshCw, Clock } from "lucide-react";
import { motion } from "framer-motion";
import { EngineToggleButton } from "@/components/engine-toggle-button";

// ── Group scan shapes (SSE: scan_started / group_scanned / scan_complete) ──────
export interface FamilySummary {
  name: string;       // "direction" | "overunder" | "evenodd" | "matchdiff"
  contract: string | null;
  shouldTrade: boolean;
  confidence: number;
  quality: number;
  rejectReason: string | null;
}

export interface GroupScanResult {
  group: string;
  scanned: number;
  bestSymbol: string;
  bestDisplayName: string;
  quality: number;
  shouldTrade: boolean;
  contract: string | null;
  confidence: number;
  family?: string;
  families?: FamilySummary[];   // all enabled families for this market
  rejectReason?: string | null;
  cursorIdx?: number;
  totalInGroup?: number;
  scanningAt?: number;
}

const GROUP_COLORS: Record<string, string> = {
  "Volatility 1s": "#00ffff",
  "Volatility":    "#8b5cf6",
  "Jump Indices":  "#f59e0b",
  "Bull/Bear":     "#10b981",
};
const CONTRACT_SHORT: Record<string, string> = {
  CALL: "RISE", PUT: "FALL", DIGITOVER: "OVER", DIGITUNDER: "UNDER", DIGITEVEN: "EVEN", DIGITODD: "ODD",
  DIGITMATCH: "MATCH", DIGITDIFF: "DIFF",
};
const FAMILY_COLORS: Record<string, string> = {
  direction:  "#10b981",
  overunder:  "#06b6d4",
  evenodd:    "#8b5cf6",
  matchdiff:  "#a855f7",
};
const CONTRACT_COLORS_MAP: Record<string, string> = {
  CALL: "#10b981", PUT: "#ef4444",
  DIGITOVER: "#06b6d4", DIGITUNDER: "#f59e0b",
  DIGITEVEN: "#8b5cf6", DIGITODD: "#ec4899",
  DIGITMATCH: "#a855f7", DIGITDIFF: "#14b8a6",
};

// ── Parallel group scanner — all 4 groups racing in real time ─────────────────
// Unchanged behaviour: this is the autonomous engine's own live view, rendered
// inside the Quick Strike card while the engine is on.
export function ParallelGroupScanner({ groups, isScanning, winner, lastSkipReason }: {
  groups: Record<string, GroupScanResult | "scanning">;
  isScanning: boolean;
  winner: string | null;
  lastSkipReason: string | null;
}) {
  const GROUP_ORDER = ["Volatility 1s", "Volatility", "Jump Indices", "Bull/Bear"];
  const hasAnyData = Object.keys(groups).length > 0;

  if (!isScanning && !hasAnyData) return null;

  return (
    <div className="rounded-lg border border-primary/15 bg-primary/3 p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <div className="flex gap-0.5">
          {[0,1,2].map(i => (
            <span key={i} className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
        <span className="text-[10px] font-mono text-primary/80 uppercase tracking-widest">
          {isScanning ? "Scanning markets — rotating cursor across all groups" : "Last scan results"}
        </span>
        {winner && (
          <span className="ml-auto text-[9px] font-mono text-green-400 border border-green-500/30 px-1.5 py-0.5 rounded">
            ✓ EXECUTING: {winner}
          </span>
        )}
      </div>

      {/* Per-group cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {GROUP_ORDER.map(groupName => {
          const result = groups[groupName];
          const color = GROUP_COLORS[groupName] ?? "#00ffff";
          const isGroupScanning = result === "scanning";
          const isWinner = result !== "scanning" && result && winner && result.bestSymbol === winner;

          return (
            <div
              key={groupName}
              className="rounded-md p-2 border transition-all"
              style={{
                borderColor: isWinner ? color : `${color}25`,
                background: isWinner ? `${color}12` : `${color}06`,
                boxShadow: isWinner ? `0 0 8px ${color}30` : undefined,
              }}
            >
              {/* Group header */}
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[9px] font-mono font-bold uppercase tracking-wide" style={{ color }}>
                  {groupName}
                </span>
                {isGroupScanning ? (
                  <span className="w-1 h-1 rounded-full animate-pulse" style={{ background: color }} />
                ) : result ? (
                  <span className={`text-[8px] font-mono px-1 py-0.5 rounded ${result.shouldTrade ? "text-green-400 bg-green-500/15" : "text-zinc-500 bg-zinc-800/50"}`}>
                    {result.shouldTrade ? "GO" : "SKIP"}
                  </span>
                ) : (
                  <span className="text-[8px] text-zinc-600 font-mono">—</span>
                )}
              </div>

              {isGroupScanning ? (
                <div className="space-y-1">
                  <div className="h-2 rounded bg-black/20 overflow-hidden">
                    <div className="h-full rounded animate-pulse" style={{ width: "60%", background: color, opacity: 0.4 }} />
                  </div>
                  <div className="text-[8px] text-muted-foreground font-mono">Scanning…</div>
                </div>
              ) : result && typeof result === "object" ? (
                <div className="space-y-1.5">
                  {/* Market name + cursor position */}
                  <div>
                    <div className="text-[10px] font-semibold leading-tight truncate">{result.bestDisplayName}</div>
                    <div className="flex items-center gap-1">
                      <span className="text-[8px] font-mono text-muted-foreground">{result.bestSymbol}</span>
                      {result.cursorIdx !== undefined && result.totalInGroup !== undefined && (
                        <span className="text-[7px] font-mono text-zinc-600">[{result.cursorIdx + 1}/{result.totalInGroup}]</span>
                      )}
                    </div>
                  </div>

                  {/* Per-family badges — shows ALL enabled families, not just the winner */}
                  {result.families && result.families.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {result.families.map(fam => {
                        const ct = fam.contract ?? "";
                        const ctColor = CONTRACT_COLORS_MAP[ct] ?? FAMILY_COLORS[fam.name] ?? "#71717a";
                        const label = CONTRACT_SHORT[ct] ?? ct;
                        return (
                          <span
                            key={fam.name}
                            title={fam.rejectReason ?? (fam.shouldTrade ? "Ready to trade" : "Not ready")}
                            className="text-[7px] font-mono px-1 py-0.5 rounded border leading-none"
                            style={fam.shouldTrade
                              ? { color: ctColor, borderColor: `${ctColor}60`, background: `${ctColor}18` }
                              : { color: "#52525b", borderColor: "#3f3f46", background: "#18181b" }
                            }
                          >
                            {label || fam.name}{fam.shouldTrade ? " ✓" : ""}
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    /* Fallback: single contract badge (old server version) */
                    result.contract && (
                      <span className="text-[8px] font-mono" style={{ color: `${color}90` }}>
                        {CONTRACT_SHORT[result.contract] ?? result.contract}
                      </span>
                    )
                  )}

                  {/* Confidence + quality bar */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-mono font-bold" style={{ color: result.shouldTrade ? color : "#71717a" }}>
                      {result.confidence.toFixed(0)}%
                    </span>
                    <span className="text-[7px] font-mono text-zinc-600">q{result.quality.toFixed(0)}</span>
                  </div>
                  <div className="h-0.5 w-full bg-black/20 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(100, result.quality)}%`, background: result.shouldTrade ? color : "#52525b" }} />
                  </div>
                </div>
              ) : (
                <div className="text-[8px] text-muted-foreground font-mono mt-1">Waiting…</div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Skip-reason status bar ─────────────────────────────────────────── */}
      {!winner && lastSkipReason && (
        <div className="mt-1 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5">
          <span className="text-amber-400 text-[9px] font-mono mt-0.5 shrink-0">⚠ SKIP</span>
          <span className="text-[9px] font-mono text-amber-300/80 leading-relaxed break-words">{lastSkipReason}</span>
        </div>
      )}
      {winner && (
        <div className="mt-1 flex items-center gap-2 rounded-md border border-green-500/20 bg-green-500/5 px-2.5 py-1.5">
          <span className="text-green-400 text-[9px] font-mono shrink-0">✓ TRADE</span>
          <span className="text-[9px] font-mono text-green-300/80">Executing trade on {winner} — all gates passed</span>
        </div>
      )}
    </div>
  );
}

// ── Autonomous engine card ────────────────────────────────────────────────────
/**
 * The autonomous engine's live view, shown in the Quick Strike card's slot while
 * the engine is running. Same visual language as the Quick Strike card (corner
 * accents, scan line, grid overlay) so the two states read as one surface that
 * flips. Deliberately minimal header — no agent counts, no trade counters.
 */
export function AutonomousEngineCard({
  countdown,
  groups,
  isScanning,
  winner,
  lastSkipReason,
}: {
  countdown: number | null;
  groups: Record<string, GroupScanResult | "scanning">;
  isScanning: boolean;
  winner: string | null;
  lastSkipReason: string | null;
}) {
  const status = winner ? "EXECUTING" : isScanning ? "SCANNING" : "ONLINE";
  const statusColor = winner ? "#10b981" : "#00ffff";

  return (
    <div
      className="relative w-full h-full rounded-2xl border overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #0d1a17 0%, #101014 55%, #0a0f0d 100%)",
        borderColor: "rgba(16,185,129,0.25)",
        boxShadow: "0 0 30px rgba(16,185,129,0.12), 0 0 60px rgba(16,185,129,0.05), inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      {/* Corner accents */}
      <span className="absolute top-0 left-0 w-5 h-5 border-t-2 border-l-2 border-emerald-400/70 rounded-tl-2xl" />
      <span className="absolute top-0 right-0 w-5 h-5 border-t-2 border-r-2 border-emerald-400/70 rounded-tr-2xl" />
      <span className="absolute bottom-0 left-0 w-5 h-5 border-b-2 border-l-2 border-emerald-400/70 rounded-bl-2xl" />
      <span className="absolute bottom-0 right-0 w-5 h-5 border-b-2 border-r-2 border-emerald-400/70 rounded-br-2xl" />

      {/* Scan line */}
      <motion.div
        className="absolute inset-x-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, rgba(16,185,129,0.5), transparent)" }}
        animate={{ top: ["0%", "100%", "0%"] }}
        transition={{ duration: 4, ease: "linear", repeat: Infinity }}
      />

      {/* Grid overlay */}
      <div className="absolute inset-0 opacity-[0.025]" style={{
        backgroundImage: `linear-gradient(rgba(16,185,129,1) 1px, transparent 1px), linear-gradient(90deg, rgba(16,185,129,1) 1px, transparent 1px)`,
        backgroundSize: "20px 20px"
      }} />

      <div className="relative z-10 p-4 flex flex-col gap-3 h-full">
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="min-w-0 truncate text-[10px] font-mono uppercase tracking-widest text-emerald-300/80">
            Autonomous Engine
          </span>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <span
              className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider"
              style={{ color: statusColor, borderColor: `${statusColor}50`, background: `${statusColor}15` }}
            >
              {status}
            </span>
            {/* Stop the engine straight from the card */}
            <EngineToggleButton />
          </div>
        </div>

        {/* Loop status */}
        <div className="flex items-center gap-4 p-3 rounded-lg bg-green-500/5 border border-green-500/20 overflow-hidden">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <RefreshCw className="w-3.5 h-3.5 text-green-500 animate-spin shrink-0" />
            <span className="text-xs text-green-400 font-mono truncate">
              {isScanning ? "Running 4-group parallel tournament…" : winner ? `Executing: ${winner}` : "Scanning markets…"}
            </span>
          </div>
          {countdown !== null && (
            <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground shrink-0">
              <Clock className="w-3 h-3" />
              <span>Next trade in <span className="text-foreground font-bold">{countdown}s</span></span>
            </div>
          )}
        </div>

        {/* The 4-group tournament, live */}
        <ParallelGroupScanner
          groups={groups}
          isScanning={isScanning}
          winner={winner}
          lastSkipReason={lastSkipReason}
        />
      </div>
    </div>
  );
}
