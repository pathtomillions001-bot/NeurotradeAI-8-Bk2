import { useState, useEffect, useRef } from "react";
import { useGetMarketDetail, useExecuteTrade, useGetAiRecommendationForMarket, useGetAiEngineStatus } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { toast } from "sonner";
import { ArrowLeft, TrendingUp, TrendingDown, AlertTriangle, Wifi, WifiOff, Activity, ArrowUp, ArrowDown, Brain, Zap, Layers, Copy, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { MATCH_PAYOUT, DIFF_PAYOUT } from "@/lib/payouts";

// ── AI Trade Panel ────────────────────────────────────────────────────────────
// Unified recommendation panel synced to all 3 contract types + agent intelligence

function TierBadge({ tier }: { tier: 1 | 2 | 0 }) {
  if (tier === 1) return <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/20">SAFE</span>;
  if (tier === 2) return <span className="text-[8px] font-bold px-1.5 py-0.5 rounded border bg-secondary/40 text-zinc-500 border-zinc-700">TIER 2</span>;
  return <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 border border-red-500/20">RISKY</span>;
}

function DigitBarrierButton({
  option, isRecommended, onClick,
}: {
  option: { contractType: string; barrier: number; winProbability: number; expectedValue: number; payout: number; tier: number };
  isRecommended: boolean;
  onClick: () => void;
}) {
  const label = option.contractType === "DIGITOVER" ? `OVER ${option.barrier}` : `UNDER ${option.barrier}`;
  const winPct = Math.round(option.winProbability * 100);
  const evPct = (option.expectedValue * 100).toFixed(1);
  const hasEdge = option.expectedValue > 0;
  const tier = option.tier as 1 | 2 | 0;

  return (
    <button onClick={onClick}
      className={`relative flex flex-col items-center p-2 rounded-lg border text-center transition-all hover:scale-[1.03] active:scale-[0.98] ${
        isRecommended
          ? "border-primary/60 bg-primary/10 shadow-sm shadow-primary/20"
          : tier === 1
            ? "border-green-500/25 bg-green-500/5 hover:border-green-500/40"
            : "border-border bg-secondary/15 hover:border-muted-foreground/25"
      }`}
    >
      {isRecommended && <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 text-[7px] font-bold text-primary bg-card px-1.5 rounded-full border border-primary/30">AI ★</span>}
      <div className="text-[9px] font-mono font-bold text-muted-foreground">{label}</div>
      <div className={`text-sm font-mono font-bold mt-0.5 ${hasEdge ? "text-green-400" : "text-amber-400"}`}>{winPct}%</div>
      <div className={`text-[8px] font-mono mt-0.5 ${hasEdge ? "text-green-500/70" : "text-zinc-600"}`}>{hasEdge ? `+${evPct}%` : `${evPct}%`}</div>
      <div className="mt-1"><TierBadge tier={tier} /></div>
    </button>
  );
}



// ── Digit distribution bar ─────────────────────────────────────────────────────
function DigitBar({ digit, count, pct, hot, cold, barrier, contractType }: {
  digit: number; count: number; pct: number; hot: boolean; cold: boolean; barrier?: number; contractType?: string;
}) {
  const isOver = contractType?.includes("OVER");
  const isUnder = contractType?.includes("UNDER");
  const highlighted = (isOver && digit > (barrier ?? 5)) || (isUnder && digit < (barrier ?? 5));
  const bgColor = highlighted ? "bg-primary" : hot ? "bg-amber-500" : cold ? "bg-red-500/60" : "bg-secondary";

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="text-[10px] font-mono text-muted-foreground">{pct}%</div>
      <div className="w-full flex flex-col items-center justify-end" style={{ height: "48px" }}>
        <div className={`w-full rounded-sm transition-all duration-300 ${bgColor}`} style={{ height: `${Math.max(4, pct * 2)}px` }} />
      </div>
      <div className={`text-xs font-mono font-bold ${highlighted ? "text-primary" : hot ? "text-amber-400" : "text-muted-foreground"}`}>{digit}</div>
    </div>
  );
}

// ── Rise/Fall trend analysis panel ────────────────────────────────────────────
function RiseFallPanel({ trendStats, agentData, onTrade }: {
  trendStats: any;
  agentData?: { probUp: number; probDown: number; weightedScore: number; shouldTrade: boolean; recommendedDuration: number };
  onTrade: (type: string, dir: "up" | "down", barrier?: number, duration?: number) => void;
}) {
  if (!trendStats) return null;
  const {
    direction, strength, winProb, streak, streakDir, momentum, samples,
    recommendRise = false, recommendFall = false,
    recentRisePct = 50, recentFallPct = 50,
    risePct = 50, fallPct = 50,
    rsi = 50, hotStreak = 0, hotDirection = "none", streakInfo = "",
    bias = "neutral",
  } = trendStats;

  // Blend 9-agent direction probabilities (65%) with statistical win prob (35%)
  const agentProbUp = agentData?.probUp ?? null;
  const agentProbDown = agentData?.probDown ?? null;
  const risingPct = agentProbUp !== null
    ? Math.round(agentProbUp * 100 * 0.65 + (winProb?.rise ?? 50) * 0.35)
    : winProb?.rise ?? 50;
  const fallingPct = agentProbDown !== null
    ? Math.round(agentProbDown * 100 * 0.65 + (winProb?.fall ?? 50) * 0.35)
    : winProb?.fall ?? 50;

  // Agent-driven recommendation overrides statistical signals when available
  const isRiseRecommended = agentData
    ? (agentData.probUp > 0.52 && agentData.shouldTrade && agentData.probUp >= agentData.probDown)
    : recommendRise;
  const isFallRecommended = agentData
    ? (agentData.probDown > 0.52 && agentData.shouldTrade && agentData.probDown > agentData.probUp)
    : recommendFall;
  const isHotStreak = hotStreak >= 3;
  const rsiOverbought = rsi > 70;
  const rsiOversold   = rsi < 30;
  const agentDuration = agentData?.recommendedDuration ?? 5;
  const wscore = agentData?.weightedScore ?? 0;

  return (
    <Card className="bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-400" />
          Rise &amp; Fall Analysis
          {samples > 0 && <span className="text-[10px] text-muted-foreground font-normal">({samples} ticks)</span>}
          {(rsiOverbought || rsiOversold) && (
            <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold ${rsiOverbought ? "bg-red-500/10 border-red-500/30 text-red-400" : "bg-green-500/10 border-green-500/30 text-green-400"}`}>
              RSI {rsi} {rsiOverbought ? "OB" : "OS"}
            </span>
          )}
          <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">

        {/* Main action buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onTrade("CALL", "up", undefined, agentDuration)}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${
              isRiseRecommended ? "border-green-500/60 bg-green-500/10" : "border-border bg-secondary/30 hover:border-green-500/30"
            }`}
          >
            <ArrowUp className={`w-6 h-6 mb-1.5 ${isRiseRecommended ? "text-green-400" : "text-muted-foreground"}`} />
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Rise</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isRiseRecommended ? "text-green-400" : "text-foreground"}`}>{risingPct.toFixed(0)}%</div>
            <div className="text-[9px] text-muted-foreground">{agentProbUp !== null ? "9-agent win prob" : "win probability"}</div>
            {isRiseRecommended && <Badge className="mt-1.5 text-[9px] bg-green-500/20 text-green-400 border-green-500/30">AI FAVOURS · {agentDuration}t</Badge>}
          </button>
          <button
            onClick={() => onTrade("PUT", "down", undefined, agentDuration)}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${
              isFallRecommended ? "border-red-500/60 bg-red-500/10" : "border-border bg-secondary/30 hover:border-red-500/30"
            }`}
          >
            <ArrowDown className={`w-6 h-6 mb-1.5 ${isFallRecommended ? "text-red-400" : "text-muted-foreground"}`} />
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Fall</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isFallRecommended ? "text-red-400" : "text-foreground"}`}>{fallingPct.toFixed(0)}%</div>
            <div className="text-[9px] text-muted-foreground">{agentProbDown !== null ? "9-agent win prob" : "win probability"}</div>
            {isFallRecommended && <Badge className="mt-1.5 text-[9px] bg-red-500/20 text-red-400 border-red-500/30">AI FAVOURS · {agentDuration}t</Badge>}
          </button>
        </div>

        {/* AI recommendation hint */}
        {agentData && (
          <div className="text-[8px] text-muted-foreground px-1">
            Optimal duration: {agentDuration}t · click Rise or Fall to auto-fill stake &amp; ticks
          </div>
        )}

        {/* Multi-window frequency table — matching EvenOdd style */}
        <div className="grid grid-cols-2 gap-1.5 text-center">
          {[
            { label: "Last 20 ticks", rise: recentRisePct, fall: recentFallPct },
            { label: "Last 100 ticks", rise: risePct,       fall: fallPct },
          ].map(({ label, rise, fall }) => {
            const dominantRise = rise > 53;
            const dominantFall = fall > 53;
            return (
              <div key={label} className="p-2 rounded-lg bg-secondary/30 border border-border">
                <div className="text-[9px] text-muted-foreground mb-1">{label}</div>
                <div className={`text-xs font-mono font-bold ${dominantRise ? "text-green-400" : "text-muted-foreground"}`}>↑ Rise {rise.toFixed(0)}%</div>
                <div className={`text-xs font-mono font-bold ${dominantFall ? "text-red-400" : "text-muted-foreground"}`}>↓ Fall {fall.toFixed(0)}%</div>
              </div>
            );
          })}
        </div>

        {/* RSI + Momentum + Streak stats */}
        <div className="grid grid-cols-3 gap-1.5">
          <div className={`p-2 rounded-lg border text-center ${rsiOverbought ? "border-red-500/30 bg-red-500/5" : rsiOversold ? "border-green-500/30 bg-green-500/5" : "border-border bg-secondary/20"}`}>
            <div className="text-[9px] text-muted-foreground mb-0.5">RSI (14)</div>
            <div className={`text-sm font-mono font-bold ${rsiOverbought ? "text-red-400" : rsiOversold ? "text-green-400" : "text-muted-foreground"}`}>{rsi}</div>
            <div className="text-[8px] text-muted-foreground mt-0.5">{rsiOverbought ? "overbought → fall" : rsiOversold ? "oversold → rise" : "neutral"}</div>
          </div>
          <div className="p-2 rounded-lg border border-border bg-secondary/20 text-center">
            <div className="text-[9px] text-muted-foreground mb-0.5">Momentum</div>
            <div className={`text-sm font-mono font-bold ${momentum > 0 ? "text-green-400" : momentum < 0 ? "text-red-400" : "text-muted-foreground"}`}>
              {momentum > 0 ? "+" : ""}{(momentum * 100).toFixed(2)}
            </div>
            <div className="text-[8px] text-muted-foreground mt-0.5">{momentum > 0.001 ? "bullish" : momentum < -0.001 ? "bearish" : "flat"}</div>
          </div>
          <div className={`p-2 rounded-lg border text-center ${isHotStreak ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-secondary/20"}`}>
            <div className="text-[9px] text-muted-foreground mb-0.5">Hot Streak</div>
            <div className={`text-sm font-mono font-bold ${hotDirection === "rise" ? "text-green-400" : hotDirection === "fall" ? "text-red-400" : "text-muted-foreground"}`}>
              {hotStreak > 0 ? `${hotStreak}× ${hotDirection === "rise" ? "↑" : "↓"}` : "—"}
            </div>
            {isHotStreak && (
              <div className="text-[8px] text-amber-400 mt-0.5">→ expect reversal</div>
            )}
          </div>
        </div>

        {/* Statistical edge bar */}
        <div className="p-2 rounded-lg bg-secondary/20 border border-border">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Signal Strength</span>
            <span className={`text-[10px] font-mono font-bold ${strength > 60 ? "text-green-400" : strength > 40 ? "text-amber-400" : "text-muted-foreground"}`}>{strength.toFixed(0)}%</span>
          </div>
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${strength > 60 ? "bg-green-400" : strength > 40 ? "bg-amber-400" : "bg-secondary-foreground/20"}`}
              style={{ width: `${Math.min(100, strength)}%` }}
            />
          </div>
        </div>

        {/* AI Signal summary */}
        <div className="p-2 rounded-lg bg-secondary/20 border border-border text-xs text-muted-foreground">
          <span className="text-foreground font-medium">AI Signal: </span>
          {isRiseRecommended
            ? `📈 RISE recommended — ${rsiOversold ? `RSI oversold (${rsi})` : recentFallPct > 65 ? `mean-reversion after ${recentFallPct}% recent falls` : `${risePct}% long-run rise bias`}`
            : isFallRecommended
            ? `📉 FALL recommended — ${rsiOverbought ? `RSI overbought (${rsi})` : recentRisePct > 65 ? `mean-reversion after ${recentRisePct}% recent rises` : `${fallPct}% long-run fall bias`}`
            : isHotStreak
            ? `⚠ ${hotStreak}× ${hotDirection.toUpperCase()} streak — reversal possible but not confirmed`
            : "⚖ Balanced — no clear edge. Wait for a stronger signal before trading Rise/Fall."}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Even / Odd analysis panel ──────────────────────────────────────────────────
function EvenOddPanel({ digitStats, agentData, onTrade }: {
  digitStats: any;
  agentData?: { weightedScore: number; shouldTrade: boolean; recommendedDuration: number };
  onTrade: (type: string, dir: "up" | "down", barrier?: number, duration?: number) => void;
}) {
  if (!digitStats) return (
    <Card className="bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="text-base leading-none">⚡</span>
          Even &amp; Odd Analysis
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
          <div className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin flex-shrink-0" />
          Collecting live digit data — panels appear once ticks arrive…
        </div>
      </CardContent>
    </Card>
  );

  const eoStats = digitStats.evenOddStats;
  const EVEN_DIGITS = [0, 2, 4, 6, 8];
  const dist: { digit: number; pct: number }[] = digitStats.distribution ?? [];

  // Frequency data — fixed window labels (always 20/50/100)
  const evenPct100 = eoStats?.evenPct ?? dist.filter((d) => EVEN_DIGITS.includes(d.digit)).reduce((s: number, d: any) => s + d.pct, 0);
  const oddPct100  = eoStats?.oddPct  ?? (100 - evenPct100);
  const evenPct20  = eoStats?.recentEvenPct   ?? evenPct100;
  const oddPct20   = eoStats?.recentOddPct    ?? oddPct100;
  const evenPct50  = eoStats?.recent50EvenPct ?? evenPct100;
  const oddPct50   = eoStats?.recent50OddPct  ?? oddPct100;

  // Core signals
  const bias: "even" | "odd" | "neutral" = eoStats?.bias ?? "neutral";
  const recommendEven = eoStats?.recommendEven ?? false;
  const recommendOdd  = eoStats?.recommendOdd  ?? false;
  const streak        = eoStats?.currentStreak ?? 0;
  const streakType    = eoStats?.currentStreakType ?? "even";
  const chiSig        = eoStats?.chiSquareSignificant ?? false;
  const chiPval       = eoStats?.chiSquarePvalue ?? 0.5;
  const edge          = eoStats?.edge ?? 0;
  const s100 = eoStats?.samples100 ?? digitStats.samples ?? 0;

  // Markov chain data — primary win probability signal
  const markovEvenGivenEven  = eoStats?.markovEvenGivenEven ?? 0.5;
  const markovEvenGivenOdd   = eoStats?.markovEvenGivenOdd  ?? 0.5;
  const markovNextEvenProb   = eoStats?.markovNextEvenProb  ?? 0.5;
  const markovSignal         = eoStats?.markovSignal ?? "neutral";
  const streakReversalSignal = eoStats?.streakReversalSignal ?? "neutral";

  const isEvenRecommended = recommendEven;
  const isOddRecommended  = recommendOdd;

  // Streak reversal label
  const isStrongStreak = streak >= 4;
  const reversalSide = streakType === "even" ? "ODD" : "EVEN";

  const agentDuration = agentData?.recommendedDuration ?? 5;
  const wscore = agentData?.weightedScore ?? 0;

  // Primary win probabilities driven by Markov chain (part of agent pipeline)
  const evenWinPct = (markovNextEvenProb * 100);
  const oddWinPct  = ((1 - markovNextEvenProb) * 100);

  return (
    <Card className="bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="text-base leading-none">⚡</span>
          Even &amp; Odd Analysis
          <span className="text-[10px] text-muted-foreground font-normal">({s100} ticks)</span>
          {chiSig && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 font-bold">
              χ² p&lt;{chiPval}
            </span>
          )}
          <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">

        {/* Trade buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onTrade("DIGITEVEN", "up", undefined, agentDuration)}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${
              isEvenRecommended ? "border-cyan-500/60 bg-cyan-500/10" : "border-border bg-secondary/30 hover:border-cyan-500/30"
            }`}
          >
            <span className={`text-xs font-mono font-bold tracking-widest mb-1 ${isEvenRecommended ? "text-cyan-400" : "text-muted-foreground"}`}>0·2·4·6·8</span>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">EVEN</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isEvenRecommended ? "text-cyan-400" : "text-foreground"}`}>{evenWinPct.toFixed(1)}%</div>
            <div className="text-[9px] text-muted-foreground">Markov probability</div>
            {isEvenRecommended && <Badge className="mt-1.5 text-[9px] bg-cyan-500/20 text-cyan-400 border-cyan-500/30">AI FAVOURS · {agentDuration}t</Badge>}
          </button>
          <button
            onClick={() => onTrade("DIGITODD", "down", undefined, agentDuration)}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${
              isOddRecommended ? "border-violet-500/60 bg-violet-500/10" : "border-border bg-secondary/30 hover:border-violet-500/30"
            }`}
          >
            <span className={`text-xs font-mono font-bold tracking-widest mb-1 ${isOddRecommended ? "text-violet-400" : "text-muted-foreground"}`}>1·3·5·7·9</span>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">ODD</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isOddRecommended ? "text-violet-400" : "text-foreground"}`}>{oddWinPct.toFixed(1)}%</div>
            <div className="text-[9px] text-muted-foreground">Markov probability</div>
            {isOddRecommended && <Badge className="mt-1.5 text-[9px] bg-violet-500/20 text-violet-400 border-violet-500/30">AI FAVOURS · {agentDuration}t</Badge>}
          </button>
        </div>

        {/* AI recommendation hint */}
        {agentData && (
          <div className="text-[8px] text-muted-foreground px-1">
            Optimal duration: {agentDuration}t · click Even or Odd to auto-fill stake &amp; ticks
          </div>
        )}

        {/* Multi-window frequency table — fixed labels (always 20 / 50 / 100) */}
        <div className="grid grid-cols-3 gap-1.5 text-center">
          {[
            { label: "Last 20",  even: evenPct20,  odd: oddPct20 },
            { label: "Last 50",  even: evenPct50,  odd: oddPct50 },
            { label: "Last 100", even: evenPct100, odd: oddPct100 },
          ].map(({ label, even, odd }) => {
            const dominantEven = even > 53;
            const dominantOdd  = odd  > 53;
            return (
              <div key={label} className="p-2 rounded-lg bg-secondary/30 border border-border">
                <div className="text-[9px] text-muted-foreground mb-1">{label}</div>
                <div className={`text-xs font-mono font-bold ${dominantEven ? "text-cyan-400" : "text-muted-foreground"}`}>E {even.toFixed(1)}%</div>
                <div className={`text-xs font-mono font-bold ${dominantOdd  ? "text-violet-400" : "text-muted-foreground"}`}>O {odd.toFixed(1)}%</div>
              </div>
            );
          })}
        </div>

        {/* Markov Chain Analysis */}
        <div className="grid grid-cols-2 gap-1.5">
          <div className="p-2 rounded-lg border border-border bg-secondary/20">
            <div className="text-[9px] text-muted-foreground mb-1">Markov P(even|prev=even)</div>
            <div className={`text-sm font-mono font-bold ${markovEvenGivenEven > 0.55 ? "text-cyan-400" : markovEvenGivenEven < 0.45 ? "text-violet-400" : "text-muted-foreground"}`}>
              {(markovEvenGivenEven * 100).toFixed(1)}%
            </div>
            <div className="text-[8px] text-muted-foreground mt-0.5">
              {markovEvenGivenEven > 0.55 ? "momentum ↗" : markovEvenGivenEven < 0.45 ? "reversal ↩" : "neutral"}
            </div>
          </div>
          <div className="p-2 rounded-lg border border-border bg-secondary/20">
            <div className="text-[9px] text-muted-foreground mb-1">Markov P(even|prev=odd)</div>
            <div className={`text-sm font-mono font-bold ${markovEvenGivenOdd > 0.55 ? "text-cyan-400" : markovEvenGivenOdd < 0.45 ? "text-violet-400" : "text-muted-foreground"}`}>
              {(markovEvenGivenOdd * 100).toFixed(1)}%
            </div>
            <div className="text-[8px] text-muted-foreground mt-0.5">
              {markovEvenGivenOdd > 0.55 ? "even likely ↗" : markovEvenGivenOdd < 0.45 ? "odd likely ↩" : "neutral"}
            </div>
          </div>
        </div>

        {/* Streak + chi-square info */}
        <div className="grid grid-cols-2 gap-1.5">
          <div className={`p-2 rounded-lg border text-center ${isStrongStreak ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-secondary/20"}`}>
            <div className="text-[9px] text-muted-foreground mb-0.5">Streak</div>
            <div className={`text-sm font-mono font-bold ${isStrongStreak ? "text-amber-400" : "text-foreground"}`}>
              {streak > 0 ? `${streak}× ${streakType.toUpperCase()}` : "—"}
            </div>
            {isStrongStreak && (
              <div className="text-[8px] text-amber-400 mt-0.5">→ bet {reversalSide}</div>
            )}
          </div>
          <div className={`p-2 rounded-lg border text-center ${chiSig ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-secondary/20"}`}>
            <div className="text-[9px] text-muted-foreground mb-0.5">Chi-Square Test</div>
            <div className={`text-sm font-mono font-bold ${chiSig ? "text-amber-400" : "text-muted-foreground"}`}>
              {chiSig ? `p<${chiPval} ✓` : "p>0.10 neutral"}
            </div>
          </div>
        </div>

        {/* Edge bar */}
        <div className="p-2 rounded-lg bg-secondary/20 border border-border">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Statistical Edge</span>
            <span className={`text-[10px] font-mono font-bold ${edge > 5 ? "text-amber-400" : "text-muted-foreground"}`}>{edge.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${edge > 8 ? "bg-amber-400" : edge > 4 ? "bg-amber-500/60" : "bg-secondary-foreground/20"}`}
              style={{ width: `${Math.min(100, edge * 5)}%` }} />
          </div>
        </div>

        {/* AI Signal summary — based on Markov + streak reversal logic */}
        <div className="p-2 rounded-lg bg-secondary/20 border border-border text-xs text-muted-foreground">
          <span className="text-foreground font-medium">AI Signal: </span>
          {isEvenRecommended
            ? `🎯 EVEN recommended — ${
                streakReversalSignal === "even" ? `reversal after ${streak}× ODD streak`
                : markovSignal === "even" ? `Markov P(even|last)=${(markovNextEvenProb * 100).toFixed(0)}%`
                : chiSig ? `χ² confirmed bias (${evenPct100.toFixed(1)}%)` : "multi-signal consensus"
              }`
            : isOddRecommended
            ? `🎯 ODD recommended — ${
                streakReversalSignal === "odd" ? `reversal after ${streak}× EVEN streak`
                : markovSignal === "odd" ? `Markov P(odd|last)=${((1-markovNextEvenProb) * 100).toFixed(0)}%`
                : chiSig ? `χ² confirmed bias (${oddPct100.toFixed(1)}%)` : "multi-signal consensus"
              }`
            : isStrongStreak
            ? `⚠ ${streak}× ${streakType.toUpperCase()} streak — reversal to ${reversalSide} possible but not confirmed`
            : "⚖ Balanced — no clear edge. Avoid trading Even/Odd until a signal forms."}
        </div>
      </CardContent>
    </Card>
  );
}

export default function MarketDetail() {
  const { symbol } = useParams();
  const queryClient = useQueryClient();
  const [tradeDialog, setTradeDialog] = useState(false);
  const [tradeDir, setTradeDir] = useState<"up" | "down">("up");
  const [tradeContract, setTradeContract] = useState("");
  const [stake, setStake] = useState("");
  const [tradeBarrier, setTradeBarrier] = useState<number | undefined>(undefined);
  const [tradeDuration, setTradeDuration] = useState(5);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceHistory, setPriceHistory] = useState<{ timestamp: string; price: number }[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [lastTickAge, setLastTickAge] = useState<number>(0);
  // Live analysis state — updated via SSE on every tick
  const [liveDigitStats, setLiveDigitStats] = useState<any | null>(null);
  const [liveTrendStats, setLiveTrendStats] = useState<any | null>(null);
  const [lastLiveDigit, setLastLiveDigit] = useState<number | null>(null);
  const [dialogCountdown, setDialogCountdown] = useState<number | null>(null);
  const [bulkEnabled, setBulkEnabled] = useState(false);
  const [bulkCount, setBulkCount] = useState(3);
  const [neuroAssist, setNeuroAssist] = useState(false);
  const [bulkExecuting, setBulkExecuting] = useState(false);
  const [assistStatus, setAssistStatus] = useState<{ ready: boolean; label: string; detail: string } | null>(null);
  const [assistLoading, setAssistLoading] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastTickTimeRef = useRef<number>(Date.now());

  const { data: market, isLoading, refetch } = useGetMarketDetail(symbol || "", { query: { refetchInterval: 8000, enabled: !!symbol } } as { query: any });
  const { data: rec, refetch: refetchRec } = useGetAiRecommendationForMarket(symbol || "", { query: { refetchInterval: 3000, enabled: !!symbol } } as { query: any });
  const { data: engineStatus } = useGetAiEngineStatus({ query: { refetchInterval: 5000 } } as { query: any });
  const isPaperMode = (engineStatus as any)?.paperTradeMode ?? false;
  const executeTrade = useExecuteTrade();

  // ── SSE: live ticks + live market analysis ───────────────────────────────────
  useEffect(() => {
    if (!symbol) return;

    const es = new EventSource("/api/ai/events");
    eventSourceRef.current = es;

    es.addEventListener("connected", () => setSseConnected(true));

    es.addEventListener("tick", (e) => {
      try {
        const tick = JSON.parse(e.data);
        if (tick.symbol !== symbol) return;
        lastTickTimeRef.current = Date.now();
        setLivePrice(tick.price);
        setPriceHistory((prev) => {
          const next = [...prev, { timestamp: new Date().toISOString(), price: tick.price }];
          return next.slice(-120);
        });
      } catch { /* ignore */ }
    });

    // Live digit + trend analysis from the backend on every tick
    es.addEventListener("market_analysis", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.symbol !== symbol) return;
        if (data.digitStats) setLiveDigitStats(data.digitStats);
        if (data.trendStats) setLiveTrendStats(data.trendStats);
        // lastDigit changes on EVERY tick — show it prominently in the digit panel
        if (typeof data.lastDigit === "number") setLastLiveDigit(data.lastDigit);
      } catch { /* ignore */ }
    });

    es.addEventListener("scan_complete", () => refetchRec());

    es.onerror = () => setSseConnected(false);

    const tickAgeTimer = setInterval(() => {
      setLastTickAge(Math.round((Date.now() - lastTickTimeRef.current) / 1000));
    }, 1000);

    return () => {
      es.close();
      clearInterval(tickAgeTimer);
      setSseConnected(false);
    };
  }, [symbol, refetchRec]);

  // Seed price history + initial stats from market data
  useEffect(() => {
    if (market?.priceHistory && priceHistory.length === 0) {
      setPriceHistory(market.priceHistory);
      const lastPrice = market.priceHistory[market.priceHistory.length - 1]?.price;
      if (lastPrice) setLivePrice(lastPrice);
    }
    if (market && (market as any).digitStats) setLiveDigitStats((market as any).digitStats);
    if (market && (market as any).trendStats) setLiveTrendStats((market as any).trendStats);
  }, [market]);

  // Populate from rec on first load too
  useEffect(() => {
    if (rec) {
      if ((rec as any).digitStats) setLiveDigitStats((rec as any).digitStats);
      if ((rec as any).trendStats) setLiveTrendStats((rec as any).trendStats);
    }
  }, [rec]);

  // ── Trade dialog countdown — MUST be before any early return (Rules of Hooks) ─
  useEffect(() => {
    if (!tradeDialog) { setDialogCountdown(null); return; }
    setDialogCountdown(15);
    const iv = setInterval(() => setDialogCountdown((c) => (c !== null ? Math.max(0, c - 1) : null)), 1000);
    return () => clearInterval(iv);
  }, [tradeDialog]);

  // ── NeuroAI Quantum Assist polling — MUST be before early return ──
  useEffect(() => {
    if (!tradeDialog || !neuroAssist || !symbol || !tradeContract) {
      setAssistStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function fetchAssist() {
      try {
        setAssistLoading(true);
        const res = await fetch("/api/trades/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol,
            contractType: tradeContract,
            barrier: tradeBarrier ?? null,
            duration: tradeDuration,
          }),
        });
        if (!res.ok) throw new Error("assist failed");
        const data = await res.json();
        if (!cancelled) {
          setAssistStatus({ ready: !!data.ready, label: data.label, detail: data.detail });
        }
      } catch {
        if (!cancelled) {
          setAssistStatus(prev => prev ?? { ready: false, label: "Calibrating…", detail: "Syncing Quantum analysis…" });
        }
      } finally {
        if (!cancelled) setAssistLoading(false);
      }
    }

    fetchAssist();
    timer = setInterval(fetchAssist, 1400);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [tradeDialog, neuroAssist, symbol, tradeContract, tradeBarrier, tradeDuration]);

  if (isLoading || !market) {
    return (
      <div className="p-8 flex items-center gap-3 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        Loading {symbol} analysis...
      </div>
    );
  }

  const recommendation = rec ?? market.recommendation;
  // Use live stats (SSE) first, fallback to rec/market data
  const digitStats = liveDigitStats ?? (rec as any)?.digitStats ?? (market as any)?.digitStats;
  const trendStats = liveTrendStats ?? (rec as any)?.trendStats ?? null;
  const digitBarrier = (rec as any)?.digitBarrier ?? (market as any)?.digitBarrier;
  const suggestedContracts = (rec as any)?.suggestedContractTypes ?? (recommendation as any)?.suggestedContractTypes ?? [];
  const chartData = priceHistory.length > 0 ? priceHistory : market.priceHistory;
  const currentPrice = livePrice ?? chartData[chartData.length - 1]?.price ?? 0;
  const startPrice = chartData[0]?.price ?? currentPrice;
  const priceChange = startPrice > 0 ? ((currentPrice - startPrice) / startPrice) * 100 : 0;

  // Match the backend DERIV_MARKETS pipSize definitions exactly:
  // R_50, R_75, RDBULL, RDBEAR → pipSize 4 (4 decimal places)
  // R_10, R_25, 1HZ15V, 1HZ30V, 1HZ90V → pipSize 3 (3 decimal places)
  // R_100, 1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V, JD* → pipSize 2 (2 decimal places)
  const pipSize = (
    symbol?.includes("R_50") || symbol?.includes("R_75") ||
    symbol === "RDBULL" || symbol === "RDBEAR"
  ) ? 4 : (
    symbol === "R_10" || symbol === "R_25" ||
    symbol === "1HZ15V" || symbol === "1HZ30V" || symbol === "1HZ90V"
  ) ? 3 : 2;

  function openTradeDialog(contractType: string, direction: "up" | "down", barrier?: number, duration?: number) {
    setTradeContract(contractType);
    setTradeDir(direction);
    setTradeBarrier(barrier);
    setTradeDuration(duration ?? (rec as any)?.recommendedDuration ?? 5);
    setStake(String(recommendation?.stake ?? 1));
    setTradeDialog(true);
  }

  // ── NeuroAI assist — server-evaluated via Quantum engine (same as FAB) ──
  // Calls POST /api/trades/assist with exact contract/barrier/duration.
  // Hides Markov/Shannon internals, returns simple Ready/Wait for user's ticks.
  function getNeuroAssistStatus(): { state: "ready" | "wait"; label: string; detail: string } | null {
    if (!neuroAssist) return null;
    if (!assistStatus) return { state: "wait", label: "Analyzing…", detail: "Quantum engine evaluating your " + tradeDuration + "-tick setup…" };
    return { state: assistStatus.ready ? "ready" : "wait", label: assistStatus.label, detail: assistStatus.detail };
  }

  async function handleExecuteTrade() {
    if (!symbol || !stake) return;
    const assist = getNeuroAssistStatus();
    // When NeuroAI assist is ON, enforce Quantum timing for ALL trades (single + bulk)
    // This makes assist actually helpful — it evaluates your exact barrier + ticks.
    if (neuroAssist && assist?.state === "wait") {
      const isBulk = bulkEnabled && bulkCount > 1;
      toast.error(
        isBulk
          ? "AI suggests waiting — bulk trades require precise timing. Wait for Ready signal."
          : `AI suggests waiting — ${assist.detail} Adjust ticks or wait for Ready.`
      );
      return;
    }

    const singleStake = Number(stake);
    if (bulkEnabled && bulkCount > 1) {
      const count = Math.min(10, Math.max(2, Math.floor(bulkCount)));
      const totalStake = singleStake * count;
      if (totalStake > 0 && singleStake <= 0) {
        toast.error("Stake must be greater than 0");
        return;
      }
      setBulkExecuting(true);
      toast.info(`Executing ` + count + `× ` + (tradeContract || "trade") + ` @ $` + singleStake.toFixed(2) + ` — total $` + totalStake.toFixed(2));
      try {
        const promises = Array.from({ length: count }, () => {
          return new Promise<any>((resolve, reject) => {
            const payload = {
              symbol,
              contractType: tradeContract || (tradeDir === "up" ? "CALL" : "PUT"),
              direction: tradeDir,
              stake: singleStake,
              duration: tradeDuration,
              durationUnit: "t" as const,
              barrier: tradeBarrier,
            };
            const mut: any = executeTrade as any;
            if (mut.mutateAsync) {
              mut.mutateAsync({ data: payload }).then(resolve).catch(reject);
            } else {
              fetch("/api/trades", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              }).then(r => r.json().then(j => r.ok ? resolve(j) : reject(j))).catch(reject);
            }
          });
        });

        const results: any[] = await Promise.allSettled(promises).then(settled =>
          settled.map(s => s.status === "fulfilled" ? s.value : null).filter(Boolean)
        );

        const wonCount = results.filter(r => r.status === "won").length;
        const totalProfit = results.reduce((sum, r) => sum + Number(r.profit ?? 0), 0);
        const first = results[0];
        if (results.length === 0) {
          toast.error("Bulk trades failed to execute");
        } else if (results.length === 1) {
          toast.success(`Trade ` + (first.status === "won" ? "WON 🎉" : "LOST") + ` — ` + (first.status === "won" ? "+" : "") + `$` + Number(first.profit ?? 0).toFixed(2));
        } else {
          if (wonCount === results.length) {
            toast.success(`Bulk complete: ` + wonCount + `/` + results.length + ` WON 🎉 — +$` + totalProfit.toFixed(2));
          } else if (wonCount === 0) {
            toast.error(`Bulk complete: 0/` + results.length + ` won — $` + totalProfit.toFixed(2));
          } else {
            toast.success(`Bulk complete: ` + wonCount + `/` + results.length + ` won — $` + totalProfit.toFixed(2));
          }
        }
        setTradeDialog(false);
        queryClient.invalidateQueries();
        refetch();
      } catch (err: any) {
        toast.error(err?.error || "Bulk trade failed");
      } finally {
        setBulkExecuting(false);
      }
      return;
    }

    // Single trade path
    executeTrade.mutate({
      data: { symbol, contractType: tradeContract || (tradeDir === "up" ? "RISE" : "FALL"), direction: tradeDir, stake: singleStake, duration: tradeDuration, durationUnit: "t", barrier: tradeBarrier }
    }, {
      onSuccess: (result: any) => {
        toast.success(`Trade ` + (result.status === "won" ? "WON 🎉" : "LOST") + ` — ` + (result.status === "won" ? "+" : "") + `$` + Number(result.profit ?? 0).toFixed(2));
        setTradeDialog(false);
        queryClient.invalidateQueries();
        refetch();
      },
      onError: (err: any) => toast.error(err?.error || "Trade failed"),
    });
  }

  // RDBULL and RDBEAR fully support digit contracts (OVER/UNDER, EVEN/ODD, MATCH/DIFF)
  const isDigitMarket = !!(symbol?.includes("R_") || symbol?.includes("1HZ") || symbol?.startsWith("JD") || symbol === "RDBULL" || symbol === "RDBEAR");

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-6 max-w-7xl mx-auto space-y-5 pb-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/markets">
            <button className="p-1.5 rounded-md hover:bg-secondary transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl md:text-2xl font-bold tracking-tight">{market.displayName}</h1>
              <div className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${sseConnected ? "text-green-400 border-green-500/30 bg-green-500/5" : "text-zinc-500 border-zinc-700"}`}>
                {sseConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {sseConnected ? `LIVE ${lastTickAge < 3 ? "·" : `${lastTickAge}s ago`}` : "connecting..."}
              </div>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-muted-foreground text-sm font-mono">{symbol}</span>
              <Badge variant="outline" className="text-[10px] capitalize">synthetic</Badge>
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-bold tabular-nums">
            {currentPrice > 0 ? currentPrice.toFixed(pipSize) : "—"}
          </div>
          <div className={`text-sm font-mono ${priceChange >= 0 ? "text-green-400" : "text-red-400"}`}>
            {priceChange >= 0 ? "+" : ""}{priceChange.toFixed(4)}%
          </div>
        </div>
      </div>

      {/* Live Price Chart */}
      <Card className="bg-card">
        <CardContent className="pt-4 pb-2">
          <div className="h-36 md:h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="timestamp" hide />
                <YAxis domain={["auto", "auto"]} hide />
                <Tooltip
                  content={({ active, payload }) => active && payload?.[0] ? (
                    <div className="bg-card border border-border px-2 py-1 rounded text-xs font-mono">
                      {Number(payload[0].value).toFixed(pipSize)}
                    </div>
                  ) : null}
                />
                <Area type="monotone" dataKey="price" stroke="hsl(var(--primary))" fill="url(#priceGrad)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Extract 13-agent outputs from coordinator recommendation */}
      {(() => {
        const agentOutputs = (rec as any)?.agentOutputs ?? {};
        const dirAgent = agentOutputs?.direction?.data ?? agentOutputs?.riseFallAgent?.data;
        const durationAgent = agentOutputs?.durationOptimizer?.data ?? agentOutputs?.executionTiming?.data;
        const agentRecommendedDuration = durationAgent?.duration ?? (rec as any)?.recommendedDuration ?? 5;

        // Use the rise-fall agent's own score to decide if Rise/Fall should be
        // highlighted. Previously this used masterAgent?.shouldTrade which was
        // always undefined (confidenceFusion.data has no shouldTrade field), so
        // no AI highlights ever appeared. Now we check the riseFallAgent score
        // directly — score ≥ 63 ("buy" threshold) means the agent has an edge.
        const rfAgent = agentOutputs?.riseFallAgent ?? agentOutputs?.direction;
        const rfScore = rfAgent?.score ?? 0;
        const rfShouldTrade = rfScore >= 63;

        const rfAgentData = dirAgent ? {
          probUp: dirAgent.probUp ?? 0.5,
          probDown: dirAgent.probDown ?? 0.5,
          weightedScore: rfScore,
          shouldTrade: rfShouldTrade,
          recommendedDuration: agentRecommendedDuration,
        } : undefined;

        // Even/Odd: use the overall shouldTrade from the recommendation when the
        // recommended contract is an Even/Odd type, otherwise use digitProbability
        // agent score for gating.
        const overallShouldTrade = !!(rec as any)?.shouldTrade;
        const overallContractType = (rec as any)?.contractType ?? "";
        const isEOContract = overallContractType === "DIGITEVEN" || overallContractType === "DIGITODD";
        const digitAgent = agentOutputs?.digitProbability ?? agentOutputs?.digitDistribution;
        const digitScore = digitAgent?.score ?? 0;
        const eoShouldTrade = isEOContract ? overallShouldTrade : digitScore >= 60;

        const eoAgentData = (digitAgent || overallShouldTrade) ? {
          weightedScore: digitScore,
          shouldTrade: eoShouldTrade,
          recommendedDuration: agentRecommendedDuration,
        } : undefined;

        // All 13 agent keys with human-readable names
        const AGENT_META: Array<{ key: string; label: string; icon: string }> = [
          { key: "marketScanner",       label: "Market Scanner",      icon: "📡" },
          { key: "tickIntelligence",    label: "Tick Intelligence",   icon: "🕐" },
          { key: "digitProbability",    label: "Digit Probability",   icon: "🔢" },
          { key: "riseFallAgent",       label: "Rise/Fall Model",     icon: "📈" },
          { key: "marketRegime",        label: "Market Regime",       icon: "🌊" },
          { key: "executionTiming",     label: "Execution Timing",    icon: "⏱" },
          { key: "confidenceFusion",    label: "Confidence Fusion",   icon: "🧠" },
          { key: "recoveryIntelligence",label: "Recovery Intel",      icon: "🛡" },
          { key: "riskIntelligence",    label: "Risk Intelligence",   icon: "⚠" },
          { key: "portfolioManager",    label: "Portfolio Manager",   icon: "💼" },
          { key: "learningAgent",       label: "Learning Agent",      icon: "🎓" },
          { key: "patternDiscovery",    label: "Pattern Discovery",   icon: "🔍" },
          { key: "tradeExplainability", label: "Trade Explainability",icon: "💡" },
        ];

        const agentCards = AGENT_META.filter(a => agentOutputs[a.key]);

        return (
          <>
            {/* Rise & Fall Analysis — 13-agent driven win probabilities */}
            <RiseFallPanel trendStats={trendStats} agentData={rfAgentData} onTrade={openTradeDialog} />
            {/* Even & Odd Analysis — only for digit markets */}
            {isDigitMarket && <EvenOddPanel digitStats={digitStats} agentData={eoAgentData} onTrade={openTradeDialog} />}

          </>
        );
      })()}

      {/* Digit Analysis (OVER/UNDER) — only for digit markets */}
      {isDigitMarket && !digitStats && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              Digit Analysis — OVER/UNDER Intelligence
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
              <div className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin flex-shrink-0" />
              Collecting live digit data…
            </div>
          </CardContent>
        </Card>
      )}
      {isDigitMarket && digitStats && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              Digit Analysis — OVER/UNDER Intelligence
              {lastLiveDigit !== null && (
                <span className="ml-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/15 border border-primary/30">
                  <span className="text-[10px] text-muted-foreground">LAST</span>
                  <span className="text-base font-mono font-bold text-primary leading-none">{lastLiveDigit}</span>
                </span>
              )}
              <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Last digit highlight row — updates every tick */}
            {lastLiveDigit !== null && (
              <div className="grid grid-cols-10 gap-1">
                {[0,1,2,3,4,5,6,7,8,9].map(d => (
                  <div key={d} className={`flex items-center justify-center h-7 rounded-md text-sm font-mono font-bold transition-all duration-150 ${
                    d === lastLiveDigit ? "bg-primary text-primary-foreground scale-110 shadow-md shadow-primary/30" : "bg-secondary/30 text-muted-foreground"
                  }`}>{d}</div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-10 gap-1">
              {digitStats.distribution.map((d: any) => (
                <DigitBar
                  key={d.digit}
                  digit={d.digit}
                  count={d.count}
                  pct={d.pct}
                  hot={digitStats.hotDigits?.includes(d.digit)}
                  cold={digitStats.coldDigits?.includes(d.digit)}
                  barrier={digitBarrier}
                  contractType={recommendation?.contractType}
                />
              ))}
            </div>

            {/* Clickable OVER/UNDER trade buttons for each barrier */}
            <div className="grid grid-cols-5 gap-1.5">
              {[0, 1, 2, 3, 4].map((b) => {
                const overPct = digitStats.distribution
                  .filter((d: any) => d.digit > b)
                  .reduce((s: number, d: any) => s + d.pct, 0);
                const isHot = overPct > 60;
                return (
                  <button
                    key={`ov${b}`}
                    onClick={() => openTradeDialog("DIGITOVER", "up", b)}
                    className={`flex flex-col items-center p-2 rounded-lg border text-center transition-all hover:scale-[1.02] ${isHot ? "border-green-500/40 bg-green-500/8" : "border-border bg-secondary/20"}`}
                  >
                    <div className="text-[9px] text-muted-foreground">OVER {b}</div>
                    <div className={`text-sm font-mono font-bold ${isHot ? "text-green-400" : "text-foreground"}`}>{overPct.toFixed(0)}%</div>
                    {isHot && <div className="text-[8px] text-green-500 mt-0.5">HOT</div>}
                  </button>
                );
              })}
              {[5, 6, 7, 8, 9].map((b) => {
                const underPct = digitStats.distribution
                  .filter((d: any) => d.digit < b)
                  .reduce((s: number, d: any) => s + d.pct, 0);
                const isHot = underPct > 60;
                return (
                  <button
                    key={`un${b}`}
                    onClick={() => openTradeDialog("DIGITUNDER", "down", b)}
                    className={`flex flex-col items-center p-2 rounded-lg border text-center transition-all hover:scale-[1.02] ${isHot ? "border-blue-500/40 bg-blue-500/8" : "border-border bg-secondary/20"}`}
                  >
                    <div className="text-[9px] text-muted-foreground">UNDER {b}</div>
                    <div className={`text-sm font-mono font-bold ${isHot ? "text-blue-400" : "text-foreground"}`}>{underPct.toFixed(0)}%</div>
                    {isHot && <div className="text-[8px] text-blue-500 mt-0.5">HOT</div>}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className={`p-2 rounded-lg border ${digitStats.bias === "under" ? "bg-primary/10 border-primary/30" : "bg-secondary/30 border-border"}`}>
                <div className="text-xs text-muted-foreground">UNDER (0-4)</div>
                <div className="text-lg font-mono font-bold">{digitStats.underPct}%</div>
                <div className="text-[10px] text-muted-foreground">expected 50%</div>
              </div>
              <div className={`p-2 rounded-lg border ${digitStats.fivePct > 12 ? "bg-amber-500/10 border-amber-500/30" : "bg-secondary/30 border-border"}`}>
                <div className="text-xs text-muted-foreground">FIVE (5)</div>
                <div className="text-lg font-mono font-bold">{digitStats.fivePct}%</div>
                <div className="text-[10px] text-muted-foreground">expected 10%</div>
              </div>
              <div className={`p-2 rounded-lg border ${digitStats.bias === "over" ? "bg-primary/10 border-primary/30" : "bg-secondary/30 border-border"}`}>
                <div className="text-xs text-muted-foreground">OVER (6-9)</div>
                <div className="text-lg font-mono font-bold">{digitStats.overPct}%</div>
                <div className="text-[10px] text-muted-foreground">expected 40%</div>
              </div>
            </div>
            <div className="p-2 rounded-lg bg-secondary/30 border border-border text-xs text-muted-foreground">
              <span className="text-foreground font-medium">AI Signal: </span>
              {digitStats.bias === "over" ? `📈 OVER bias detected — ${digitStats.overPct}% of recent ticks ended with digits 6-9` :
               digitStats.bias === "under" ? `📉 UNDER bias detected — ${digitStats.underPct}% ended with digits 0-4` :
               "⚖ Neutral — digit distribution is balanced"}
              {digitStats.streakInfo && <span className="ml-2 text-amber-400">· {digitStats.streakInfo}</span>}
            </div>
          </CardContent>
        </Card>
      )}



      {/* Matches & Differs — only for digit markets */}
      {isDigitMarket && !digitStats && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <span className="text-base leading-none">🎯</span>
              Matches &amp; Differs Intelligence
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
              <div className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin flex-shrink-0" />
              Collecting live digit data…
            </div>
          </CardContent>
        </Card>
      )}
      {isDigitMarket && digitStats && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <span className="text-base leading-none">🎯</span>
              Matches &amp; Differs Intelligence
              <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Matches</strong>: win if the last digit of the closing price equals your chosen digit. <strong className="text-foreground">Differs</strong>: win if the last digit is anything but your chosen digit. AI picks the statistically best digit for each.
            </p>
            {(() => {
              // Compute best match (highest freq) and best diff (lowest freq) from live distribution
              const dist: Array<{ digit: number; pct: number }> = digitStats.distribution ?? [];
              if (dist.length === 0) return <p className="text-xs text-muted-foreground">Insufficient digit data.</p>;

              const best = [...dist].sort((a, b) => b.pct - a.pct);
              const matchDigit = best[0];       // hottest digit → best to match
              const diffDigit  = best[best.length - 1]; // coldest → best to differ from

              // EV uses canonical total-return payouts; subtract 1 for net profit.
              const matchWinP = matchDigit.pct / 100;
              const diffWinP  = 1 - diffDigit.pct / 100;
              const matchEV   = matchWinP * (MATCH_PAYOUT - 1) - (1 - matchWinP);
              const diffEV    = diffWinP * (DIFF_PAYOUT - 1) - (1 - diffWinP);

              return (
                <div className="grid grid-cols-2 gap-3">
                  {/* DIGITMATCH */}
                  <div className="space-y-2">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Matches</div>
                    <button
                      onClick={() => openTradeDialog("DIGITMATCH", "up", matchDigit.digit)}
                      className={`w-full flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${
                        matchEV > 0
                          ? "border-green-500/60 bg-green-500/10"
                          : "border-border bg-secondary/30 hover:border-green-500/30"
                      }`}
                    >
                      <div className="text-[9px] font-mono text-muted-foreground">MATCH digit</div>
                      <div className={`text-3xl font-mono font-bold mt-0.5 ${matchEV > 0 ? "text-green-400" : "text-foreground"}`}>{matchDigit.digit}</div>
                      <div className="text-[10px] text-muted-foreground mt-1">freq {matchDigit.pct.toFixed(1)}% · P(win) {(matchWinP * 100).toFixed(1)}%</div>
                      <div className={`text-[10px] font-mono mt-0.5 ${matchEV > 0 ? "text-green-500" : "text-zinc-600"}`}>
                        EV {matchEV > 0 ? "+" : ""}{(matchEV * 100).toFixed(1)}%
                      </div>
                      {matchEV > 0 && <Badge className="mt-1.5 text-[9px] bg-green-500/20 text-green-400 border-green-500/30">AI EDGE</Badge>}
                    </button>
                    <div className="grid grid-cols-5 gap-1">
                      {dist.map((d) => {
                        const isHot = d.pct > 13;
                        return (
                          <button key={d.digit} onClick={() => openTradeDialog("DIGITMATCH", "up", d.digit)}
                            className={`flex flex-col items-center p-1.5 rounded border text-center transition-all hover:scale-105 ${isHot ? "border-green-500/40 bg-green-500/8" : "border-border bg-secondary/20"}`}
                          >
                            <div className="text-[9px] text-muted-foreground">{d.digit}</div>
                            <div className={`text-xs font-mono font-bold ${isHot ? "text-green-400" : "text-foreground"}`}>{d.pct.toFixed(0)}%</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {/* DIGITDIFF */}
                  <div className="space-y-2">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Differs</div>
                    <button
                      onClick={() => openTradeDialog("DIGITDIFF", "up", diffDigit.digit)}
                      className={`w-full flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${
                        diffEV > 0
                          ? "border-blue-500/60 bg-blue-500/10"
                          : "border-border bg-secondary/30 hover:border-blue-500/30"
                      }`}
                    >
                      <div className="text-[9px] font-mono text-muted-foreground">DIFFER from digit</div>
                      <div className={`text-3xl font-mono font-bold mt-0.5 ${diffEV > 0 ? "text-blue-400" : "text-foreground"}`}>{diffDigit.digit}</div>
                      <div className="text-[10px] text-muted-foreground mt-1">freq {diffDigit.pct.toFixed(1)}% · P(win) {(diffWinP * 100).toFixed(1)}%</div>
                      <div className={`text-[10px] font-mono mt-0.5 ${diffEV > 0 ? "text-blue-500" : "text-zinc-600"}`}>
                        EV {diffEV > 0 ? "+" : ""}{(diffEV * 100).toFixed(1)}%
                      </div>
                      {diffEV > 0 && <Badge className="mt-1.5 text-[9px] bg-blue-500/20 text-blue-400 border-blue-500/30">AI EDGE</Badge>}
                    </button>
                    <div className="grid grid-cols-5 gap-1">
                      {dist.map((d) => {
                        const isCold = d.pct < 7;
                        return (
                          <button key={d.digit} onClick={() => openTradeDialog("DIGITDIFF", "up", d.digit)}
                            className={`flex flex-col items-center p-1.5 rounded border text-center transition-all hover:scale-105 ${isCold ? "border-blue-500/40 bg-blue-500/8" : "border-border bg-secondary/20"}`}
                          >
                            <div className="text-[9px] text-muted-foreground">{d.digit}</div>
                            <div className={`text-xs font-mono font-bold ${isCold ? "text-blue-400" : "text-foreground"}`}>{d.pct.toFixed(0)}%</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })()}
            <div className="p-2 rounded-lg bg-secondary/30 border border-border text-xs text-muted-foreground">
              <span className="text-foreground font-medium">AI Signal: </span>
              {digitStats.distribution && (() => {
                const sorted = [...digitStats.distribution].sort((a: any, b: any) => b.pct - a.pct);
                const hot = sorted[0];
                const cold = sorted[sorted.length - 1];
                return `Hot digit: ${hot.digit} (${hot.pct.toFixed(1)}%) — best for MATCH. Cold digit: ${cold.digit} (${cold.pct.toFixed(1)}%) — best for DIFF.`;
              })()}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Trade dialog — Manual execution with Bulk & NeuroAI Assist */}
      <Dialog open={tradeDialog} onOpenChange={setTradeDialog}>
        <DialogContent className="bg-card border-border max-w-sm max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>Place Trade — {tradeContract}</span>
              {tradeBarrier != null && (
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/30">{tradeBarrier}</span>
              )}
            </DialogTitle>
          </DialogHeader>
          {isPaperMode && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-medium">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span><span className="font-bold">PAPER TRADE MODE</span> — trades are simulated, not sent to Deriv. Turn off in Settings to trade live.</span>
            </div>
          )}
          <div className="space-y-4 py-2">
            {/* Market + Counter Row */}
            <div className="p-3 bg-secondary/30 rounded-lg flex justify-between items-start gap-3">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground mb-0.5">Market</div>
                <div className="font-medium truncate">{market.displayName}</div>
                <div className="text-xs font-mono text-muted-foreground mt-0.5">Current: {currentPrice.toFixed(pipSize)}</div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span className="px-2 py-0.5 rounded-md bg-primary/10 border border-primary/30 font-mono font-bold text-primary text-xs">
                    {tradeContract.startsWith("DIGIT")
                      ? (tradeBarrier != null ? `${tradeContract.replace("DIGIT", "")} ${tradeBarrier}` : tradeContract.replace("DIGIT", ""))
                      : tradeContract === "CALL" ? "Rise (CALL)"
                      : tradeContract === "PUT" ? "Fall (PUT)"
                      : tradeContract}
                  </span>
                </div>
              </div>
              {dialogCountdown !== null && (
                <div className="flex flex-col items-center gap-1 shrink-0">
                  <div className={`w-12 h-12 rounded-full flex flex-col items-center justify-center border-2 font-mono font-bold text-sm ${dialogCountdown <= 5 ? "border-red-500/50 bg-red-500/10 text-red-400 animate-pulse" : dialogCountdown <= 10 ? "border-amber-500/50 bg-amber-500/10 text-amber-400" : "border-primary/30 bg-primary/5 text-muted-foreground"}`}>
                    <span className="leading-none">{dialogCountdown}</span>
                    <span className="text-[8px] font-normal leading-none">SEC</span>
                  </div>
                  <span className="text-[9px] text-muted-foreground font-mono">to place</span>
                </div>
              )}
            </div>

            {/* Stake + Duration */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="stake" className="text-xs">Stake (USD)</Label>
                <Input id="stake" type="number" value={stake} min="0.35" step="0.5" onChange={(e) => setStake(e.target.value)} className="font-mono bg-secondary/50 h-8 text-sm" />
                {bulkEnabled && bulkCount > 1 && stake && (
                  <div className="text-[10px] font-mono text-muted-foreground">
                    Total: <span className="text-amber-400 font-bold">${(Number(stake || 0) * bulkCount).toFixed(2)}</span> · {bulkCount}× ${Number(stake || 0).toFixed(2)}
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ticks" className="text-xs">Duration (ticks)</Label>
                <Input
                  id="ticks"
                  type="number"
                  value={tradeDuration}
                  min="1"
                  max="15"
                  step="1"
                  onChange={(e) => setTradeDuration(Math.max(1, Math.min(15, Number(e.target.value))))}
                  className="font-mono bg-secondary/50 h-8 text-sm"
                />
                <div className="text-[9px] text-muted-foreground">1 tick ≈ 1 sec</div>
              </div>
            </div>

            {/* ── Bulk Trades — manual only ── */}
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
                    <Layers className="w-3.5 h-3.5 text-amber-400" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold leading-none">Bulk Trades</p>
                    <p className="text-[10px] text-muted-foreground leading-none mt-0.5">Execute multiple at once</p>
                  </div>
                </div>
                <Switch checked={bulkEnabled} onCheckedChange={setBulkEnabled} />
              </div>
              {bulkEnabled && (
                <div className="space-y-2.5 pt-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Number of trades</span>
                    <div className="flex items-center gap-1.5">
                      <Button variant="outline" size="sm" className="h-7 w-7 p-0 border-white/10" onClick={() => setBulkCount(c => Math.max(2, c - 1))}>−</Button>
                      <div className="w-12 h-7 rounded-md bg-secondary/50 border border-white/10 flex items-center justify-center font-mono text-sm font-bold">
                        {bulkCount}
                      </div>
                      <Button variant="outline" size="sm" className="h-7 w-7 p-0 border-white/10" onClick={() => setBulkCount(c => Math.min(10, c + 1))}>+</Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {[2,3,5,7,10].map(n => (
                      <button
                        key={n}
                        onClick={() => setBulkCount(n)}
                        className={`h-6 rounded text-xs font-mono font-medium border ${bulkCount === n ? "bg-amber-500/20 border-amber-500/50 text-amber-300" : "bg-white/5 border-white/10 text-muted-foreground hover:border-white/20"}`}
                      >
                        {n}×
                      </button>
                    ))}
                  </div>
                  <div className="flex items-start gap-1.5 p-2 rounded-lg bg-amber-500/5 border border-amber-500/15">
                    <AlertTriangle className="w-3 h-3 text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-[10px] leading-relaxed text-amber-300/80">
                      Bulk over-exposes your account. Trades are filtered for precision — enable <span className="font-bold text-amber-300">NeuroAI Assist</span> for well-timed, synchronized entries.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* ── NeuroAI Quantum Assist — uses same engine as FAB, hides technical metrics ── */}
            <div className={`rounded-xl border p-3 space-y-3 ${neuroAssist ? "border-cyan-500/30 bg-cyan-500/5" : "border-white/10 bg-white/[0.03]"}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-6 h-6 rounded-md border flex items-center justify-center ${neuroAssist ? "bg-cyan-500/15 border-cyan-500/30" : "bg-secondary/30 border-white/10"}`}>
                    <Brain className={`w-3.5 h-3.5 ${neuroAssist ? "text-cyan-400" : "text-muted-foreground"}`} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold leading-none flex items-center gap-1.5">
                      NeuroAI Quantum Assist
                      <span className={`text-[8px] px-1 py-0.5 rounded font-mono ${neuroAssist ? "bg-cyan-500/20 text-cyan-300" : "bg-white/5 text-muted-foreground"}`}>{neuroAssist ? "ON" : "OFF"}</span>
                    </p>
                    <p className="text-[10px] text-muted-foreground leading-none mt-0.5">Smart timing & execution help</p>
                  </div>
                </div>
                <Switch checked={neuroAssist} onCheckedChange={setNeuroAssist} />
              </div>

              {neuroAssist && (() => {
                const assist = getNeuroAssistStatus();
                if (!assist) return null;
                const isReady = assist.state === "ready";
                return (
                  <div className={`rounded-lg p-2.5 border flex items-start gap-2.5 ${isReady ? "bg-green-500/10 border-green-500/20" : "bg-amber-500/10 border-amber-500/20"}`}>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${isReady ? "bg-green-500/20" : "bg-amber-500/20 animate-pulse"}`}>
                      {isReady ? <Zap className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-amber-400" />}
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-none ${isReady ? "text-green-400" : "text-amber-400"}`}>{assist.label}</p>
                      <p className="text-[10px] text-muted-foreground leading-relaxed mt-1">{assist.detail}</p>
                      {!isReady && bulkEnabled && bulkCount > 1 && (
                        <p className="text-[10px] font-medium text-amber-300 mt-1.5">Bulk trades are paused until timing is optimal.</p>
                      )}
                    </div>
                  </div>
                );
              })()}

              {!neuroAssist && (
                <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                  When off, you can execute trades freely. When on, NeuroAI uses the same engine as the FAB to advise timing — respecting your {tradeDuration}-tick duration — with simple Ready/Wait guidance (no technical charts).
                </p>
              )}
            </div>
          </div>
          <DialogFooter className="flex gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setTradeDialog(false)} className="flex-1">Cancel</Button>
            <Button
              onClick={handleExecuteTrade}
              disabled={executeTrade.isPending || bulkExecuting || (neuroAssist && getNeuroAssistStatus()?.state === "wait")}
              className={`flex-1 font-bold ${bulkEnabled && bulkCount > 1 ? "bg-amber-600 hover:bg-amber-500 text-white" : "bg-primary hover:bg-primary/90"}`}
            >
              {bulkExecuting || executeTrade.isPending
                ? (bulkEnabled && bulkCount > 1 ? `Executing ${bulkCount}×…` : "Executing…")
                : neuroAssist && getNeuroAssistStatus()?.state === "wait"
                  ? "Waiting for AI…"
                  : bulkEnabled && bulkCount > 1
                    ? `Execute ${bulkCount}× ${tradeContract || "Trade"}`
                    : `Execute ${tradeContract || "Trade"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
