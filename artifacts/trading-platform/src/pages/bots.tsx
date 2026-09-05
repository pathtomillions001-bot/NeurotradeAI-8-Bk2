/**
 * AI Bot Arena — the specialist bot section.
 *
 * Every bot on this page trades exactly ONE contract family. The catalogue and
 * all analysis live on the server; this page is the control room: pick a
 * specialist, arm its side/digit, set risk, and watch its own telemetry run.
 */

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot, Sparkles, Lock, Activity, ChevronRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BotConsole } from "@/components/bot-console";
import { DualLockConsole } from "@/components/dual-lock-console";
import { ApexConsole } from "@/components/apex-console";
import { ACCENTS, BOT_ICON, type BotCardData, type BotSessionStatus } from "@/lib/bots";

// ── Data ──────────────────────────────────────────────────────────────────────

function useBotCatalogue() {
  return useQuery({
    queryKey: ["bots-catalogue"],
    queryFn: async () => {
      const res = await fetch("/api/bots");
      if (!res.ok) throw new Error("Could not load the bot catalogue");
      const data = await res.json();
      return data as { bots: BotCardData[]; activeBotId: string | null };
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

function useBotStatus(onUpdate: (status: BotSessionStatus | null) => void) {
  const [session, setSession] = useState<BotSessionStatus | null>(null);

  const { data } = useQuery({
    queryKey: ["bots-status"],
    queryFn: () => fetch("/api/bots/status").then(r => (r.ok ? r.json() : null)),
    refetchInterval: 5_000,
    staleTime: 3_000,
  });

  useEffect(() => {
    setSession((data as BotSessionStatus | null) ?? null);
  }, [data]);

  // Live SSE keeps the running card in step without waiting for a poll.
  useEffect(() => {
    let es: EventSource;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      es = new EventSource("/api/ai/events");
      es.addEventListener("bot_update", (e: MessageEvent) => {
        try { setSession(JSON.parse(e.data) as BotSessionStatus); } catch { /* ignore */ }
      });
      es.onerror = () => {
        es.close();
        if (!destroyed) reconnect = setTimeout(connect, 2500);
      };
    }
    connect();

    return () => {
      destroyed = true;
      if (reconnect) clearTimeout(reconnect);
      es?.close();
    };
  }, []);

  const handle = useCallback((next: BotSessionStatus | null) => {
    setSession(next);
    onUpdate(next);
  }, [onUpdate]);

  return { session, setSession: handle };
}

// ── Bot card ──────────────────────────────────────────────────────────────────

function BotCard({ bot, isThisRunning, anotherRunning, onOpen, index }: {
  bot: BotCardData;
  isThisRunning: boolean;
  anotherRunning: boolean;
  onOpen: () => void;
  index: number;
}) {
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Sparkles;
  const s = bot.session;
  const profit = s?.totalProfit ?? 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.35 }}
    >
      <Card
        className={`group relative overflow-hidden h-full transition-all duration-300 ${
          isThisRunning
            ? `${a.panelBorder} ${a.panelBg} shadow-lg ${a.cardGlow}`
            : "border-border bg-card hover:border-white/20"
        }`}
      >
        {/* Accent wash */}
        <div className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${a.grad} opacity-60`} />

        <CardContent className="p-4 flex flex-col h-full gap-3">
          {/* Header */}
          <div className="flex items-start gap-3">
            <div className={`relative w-11 h-11 rounded-xl ${a.iconBg} ${a.iconBorder} flex items-center justify-center flex-shrink-0`}>
              <Icon className={`w-5 h-5 ${a.text}`} />
              {isThisRunning && (
                <motion.span
                  className={`absolute inset-0 rounded-xl border ${a.activeBorder}`}
                  animate={{ scale: [1, 1.25], opacity: [0.6, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
                />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-bold text-white truncate">{bot.name}</h3>
                {isThisRunning && (
                  <span className={`flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded ${a.badgeBg} ${a.text}`}>
                    <span className={`w-1 h-1 rounded-full ${a.dot} animate-pulse`} /> LIVE
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground/70">
                  {bot.code}
                </span>
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${a.badgeBg} ${a.text}`}>
                  {bot.contractLabel}
                </span>
              </div>
            </div>
          </div>

          {/* Live P&L strip when this bot is the one running */}
          {isThisRunning && s ? (
            <div className={`rounded-lg border ${a.panelBorder} bg-black/25 px-3 py-2`}>
              <div className="flex items-baseline justify-between">
                <span className={`text-xl font-bold font-mono ${profit >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {profit >= 0 ? "+" : "-"}${Math.abs(profit).toFixed(2)}
                </span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {s.winCount}W · {s.lossCount}L · {s.tradeCount} trades
                </span>
              </div>
              {s.currentMarket && (
                <p className="text-[10px] text-muted-foreground mt-1 truncate">
                  <span className={a.text}>{s.currentContractType}</span> on {s.currentMarket}
                </p>
              )}
              {s.message && (
                <p className="text-[9px] font-mono text-muted-foreground/70 mt-1 truncate">{s.message}</p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-3">{bot.description}</p>
          )}

          {/* Nominal stats */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-white/[0.03] px-2.5 py-1.5">
              <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">Nominal win</p>
              <p className="text-xs font-mono font-bold text-white/90">{bot.nominalWinRate}</p>
            </div>
            <div className="rounded-lg bg-white/[0.03] px-2.5 py-1.5">
              <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">Payout</p>
              <p className="text-xs font-mono font-bold text-white/90">{bot.nominalPayout}</p>
            </div>
          </div>

          {/* Controls */}
          <div className="pt-1 mt-auto">
            {isThisRunning ? (
              <Button
                onClick={onOpen}
                className={`w-full h-9 text-xs font-semibold ${a.solidBtn} text-white`}
              >
                <Activity className="w-3.5 h-3.5 mr-1.5" /> Open Live Session
              </Button>
            ) : (
              <Button
                onClick={onOpen}
                disabled={anotherRunning}
                variant="outline"
                className={`w-full h-9 text-xs font-semibold ${
                  anotherRunning
                    ? "border-white/5 text-muted-foreground/40"
                    : `${a.outlineBtn}`
                }`}
              >
                {anotherRunning ? (
                  <>
                    <Lock className="w-3.5 h-3.5 mr-1.5" /> Engine Busy
                  </>
                ) : (
                  <>
                    <ChevronRight className="w-3.5 h-3.5 mr-1.5" /> Deploy Bot
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Bots() {
  const [openBotId, setOpenBotId] = useState<string | null>(null);
  const [sessionFromConsole, setSessionFromConsole] = useState<BotSessionStatus | null>(null);

  const onConsoleSession = useCallback((status: BotSessionStatus | null) => {
    setSessionFromConsole(status);
  }, []);

  const { session, setSession } = useBotStatus(onConsoleSession);
  const { data, isLoading, isError, error, refetch } = useBotCatalogue();

  // The console's own SSE copy wins when it is open (it is more immediate);
  // otherwise fall back to the page-level session.
  const liveSession = sessionFromConsole ?? session;
  const activeBotId = liveSession?.running ? liveSession.botId : null;

  const bots = (data?.bots ?? []).map(bot => ({
    ...bot,
    session: liveSession?.running && liveSession.botId === bot.id ? liveSession : null,
  }));

  const openBot = bots.find(b => b.id === openBotId) ?? null;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
            <Bot className="w-6 h-6 text-primary" />
            AI Bot Arena
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Single-contract specialists — each one spends its whole analysis budget on one trade type
          </p>
        </div>

        <div className="flex items-center gap-2">
          {activeBotId ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-primary/25 bg-primary/5">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              <div>
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Active Bot</p>
                <p className="text-xs font-semibold text-primary">{liveSession?.botName ?? activeBotId}</p>
              </div>
              <span className={`text-sm font-mono font-bold ${
                (liveSession?.totalProfit ?? 0) >= 0 ? "text-green-400" : "text-red-400"
              }`}>
                {(liveSession?.totalProfit ?? 0) >= 0 ? "+" : "-"}${Math.abs(liveSession?.totalProfit ?? 0).toFixed(2)}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card">
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
              <p className="text-xs text-muted-foreground">No bot running</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Bot grid ───────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5, 6].map(i => (
            <Card key={i} className="border-border bg-card">
              <CardContent className="p-4 space-y-3">
                <div className="flex gap-3">
                  <div className="w-11 h-11 rounded-xl bg-white/5 animate-pulse" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 w-2/3 rounded bg-white/5 animate-pulse" />
                    <div className="h-2.5 w-1/2 rounded bg-white/5 animate-pulse" />
                  </div>
                </div>
                <div className="h-12 rounded bg-white/5 animate-pulse" />
                <div className="h-8 rounded bg-white/5 animate-pulse" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {isError && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-4 flex items-center justify-between gap-3">
            <p className="text-sm text-destructive-foreground">
              {(error as Error)?.message ?? "Could not load the specialist bots."}
            </p>
            <Button onClick={() => refetch()} variant="outline" size="sm">Retry</Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {bots.map((bot, i) => (
            <BotCard
              key={bot.id}
              bot={bot}
              index={i}
              isThisRunning={activeBotId === bot.id}
              anotherRunning={!!activeBotId && activeBotId !== bot.id}
              onOpen={() => setOpenBotId(bot.id)}
            />
          ))}
        </div>
      )}

      {/* ── Console ────────────────────────────────────────────────────── */}
      {/* Three consoles for three lifecycles:
          · oneShot (Apex)        — choose one contract → AI locks one market → wait
          · preLocked (Dual-Lock) — scan once → freeze the pair → run non-stop
          · everything else       — configure per trade */}
      <AnimatePresence>
        {openBot?.oneShot ? (
          <ApexConsole
            bot={openBot}
            open={openBotId !== null}
            onOpenChange={open => { if (!open) setOpenBotId(null); }}
            session={liveSession}
            onSession={setSession}
          />
        ) : openBot?.preLocked ? (
          <DualLockConsole
            bot={openBot}
            open={openBotId !== null}
            onOpenChange={open => { if (!open) setOpenBotId(null); }}
            session={liveSession}
            onSession={setSession}
          />
        ) : (
          <BotConsole
            bot={openBot}
            open={openBotId !== null}
            onOpenChange={open => { if (!open) setOpenBotId(null); }}
            session={liveSession}
            onSession={setSession}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
