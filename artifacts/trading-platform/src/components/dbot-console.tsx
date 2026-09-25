/**
 * Deriv DBot console.
 *
 * A DBot is the ONE engine in this app that does not run on the server: the
 * user builds it in Bot Studio, presses Run there, and Deriv's own bot runner
 * (in the browser) takes the trades. So this console has no deploy buttons, no
 * market scanner and no settings — it reports what the bot IS, what it has DONE
 * and offers the two actions that make sense: open Bot Studio, or stop it.
 *
 * It exists for two reasons:
 *   1. `GET /api/bots/live` publishes a running DBot as console `dbot@1`, and
 *      the console contract requires this bundle to render every id the API can
 *      ask for (src/lib/console-registry.test.ts).
 *   2. The live badge's "Open" must land somewhere useful: Bot Studio, on the
 *      very bot that is running.
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bot, ExternalLink, StopCircle, TrendingUp, TrendingDown, Activity, X } from "lucide-react";
import { Button } from "./ui/button";
import type { BotCardData, BotSessionStatus } from "@/lib/bots";
import { BOT_STUDIO_MOUNT } from "@/pages/bot-studio";
import { ACCENTS, BOT_ICON } from "@/lib/bots";

/** Live status fields the DBot registry adds on top of the shared shape. */
interface DbotLiveStatus {
  dbotId?: string;
  currentMarket?: string;
  lastSeenAt?: number | null;
}

interface DbotSummary {
  id: string;
  name: string;
  symbol: string;
  displayName: string;
  live: boolean;
  tradeCount: number;
  totalProfit: number;
  lastFill: { won: boolean; profit: number; stake: number; contractType: string } | null;
  program?: {
    seed?: { debt: number; mode: string };
    recoveryState?: { markupPercent: number; payoutMultiplier: number };
  };
}

export function DbotConsole({
  bot, open, onOpenChange, session, onSession,
}: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [summary, setSummary] = useState<DbotSummary | null>(null);
  const [stopping, setStopping] = useState(false);
  const live = session?.running === true && session.botId === "dbot";
  const dbotId = (session as (BotSessionStatus & DbotLiveStatus) | null)?.dbotId ?? null;

  // The DBot's id rides on the live status — resolve it to the full record so
  // the panel can show the ledger seed and the fills it has mirrored.
  useEffect(() => {
    if (!open || !dbotId) return;
    let dead = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/dbots/${dbotId}`);
        if (!res.ok) return;
        const data = (await res.json()) as { bot: DbotSummary };
        if (!dead) setSummary(data.bot);
      } catch {
        /* keep the last known state */
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => { dead = true; window.clearInterval(timer); };
  }, [open, dbotId]);

  const handleStop = async () => {
    if (!dbotId) return;
    setStopping(true);
    try {
      await fetch(`/api/dbots/${dbotId}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "user" }),
      });
      onSession(null);
    } finally {
      setStopping(false);
    }
  };

  if (!bot) return null;

  const name = summary?.name ?? session?.botName ?? "Deriv DBot";
  const profit = summary?.totalProfit ?? session?.totalProfit ?? 0;
  const trades = summary?.tradeCount ?? session?.tradeCount ?? 0;
  const market = summary?.displayName
    ?? (session as (BotSessionStatus & DbotLiveStatus) | null)?.currentMarket
    ?? "—";
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Bot;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-40"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            role="dialog"
            aria-label="Deriv DBot console"
            className={`fixed bottom-20 right-4 z-50 w-84 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
          >
            <div className={`flex items-center justify-between gap-2 p-4 border-b border-white/5 bg-gradient-to-r ${a.headerGrad}`}>
              <div className="flex items-center gap-2.5 min-w-0">
                <div className={`w-9 h-9 rounded-xl ${a.iconBg} ${a.iconBorder} flex items-center justify-center flex-shrink-0`}>
                  <Icon className={`w-4.5 h-4.5 ${a.text}`} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    Deriv DBot
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${a.badgeBg} ${a.text} font-normal`}>
                      {live ? "RUNNING" : "IDLE"}
                    </span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{name}</p>
                </div>
              </div>
              <button onClick={() => onOpenChange(false)} aria-label="Close console"
                      className="text-muted-foreground hover:text-white p-1 flex-shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-1.5`}>
                <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                  <Activity className="w-3 h-3" /> Running in your browser
                </p>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  A DBot is built from a scan in <span className="text-white/80">Bot Studio</span> and runs
                  on the account NeuroTrade has selected (demo stays demo, real stays real). While it runs,
                  every fill is mirrored into the app&apos;s journal and into the single shared recovery
                  ledger — and no server engine may start next to it.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                <div className="bg-black/25 rounded-lg px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">Market</p>
                  <p className="text-[11px] font-mono font-bold text-white/90 truncate">{market}</p>
                </div>
                <div className="bg-black/25 rounded-lg px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">Trades</p>
                  <p className="text-[11px] font-mono font-bold text-white/90">{trades}</p>
                </div>
                <div className="bg-black/25 rounded-lg px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">Profit</p>
                  <p className={`text-[11px] font-mono font-bold ${profit >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {profit >= 0 ? "+" : ""}{profit.toFixed(2)}
                  </p>
                </div>
              </div>

              {summary?.lastFill && (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                  {summary.lastFill.won
                    ? <TrendingUp className="w-3 h-3 text-green-400" />
                    : <TrendingDown className="w-3 h-3 text-red-400" />}
                  Last {summary.lastFill.contractType} · stake {summary.lastFill.stake.toFixed(2)} ·{" "}
                  {summary.lastFill.profit >= 0 ? "+" : ""}{summary.lastFill.profit.toFixed(2)}
                </p>
              )}

              {summary?.program?.seed && (
                <p className="text-[10px] text-muted-foreground">
                  Seeded from the shared ledger: debt {summary.program.seed.debt.toFixed(2)} →{" "}
                  {summary.program.seed.mode === "recovery" ? "starts in recovery" : "starts normal"}
                  {summary.program.recoveryState
                    ? ` · markup ${summary.program.recoveryState.markupPercent}% · payout ${summary.program.recoveryState.payoutMultiplier.toFixed(2)}`
                    : ""}
                </p>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Button
                  onClick={() => window.location.assign(dbotId ? `/bot-studio?dbot=${dbotId}` : BOT_STUDIO_MOUNT)}
                  className={`w-full h-9 text-xs font-bold ${a.solidBtn} text-white`}
                >
                  <ExternalLink className="w-3.5 h-3.5 mr-2" /> Open Bot Studio
                </Button>
                <Button
                  variant="outline"
                  onClick={handleStop}
                  disabled={stopping || !live || !dbotId}
                  className="w-full h-9 text-xs font-bold border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                >
                  <StopCircle className="w-3.5 h-3.5 mr-2" /> {stopping ? "Stopping…" : "Stop DBot"}
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
