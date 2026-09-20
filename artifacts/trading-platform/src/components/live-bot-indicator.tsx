/**
 * The always-on "active engine" indicator — fixed to the top-right of every
 * page (mobile: top bar).
 *
 * ONE chip answers one question: which engine is trading on the CONNECTED
 * Deriv account right now? It covers every executor in the app, not just the
 * AI Bots section:
 *   - the specialist bots in the AI Bot Arena,
 *   - the NeuroAI Quantum FAB session ("neuroai"),
 *   - the main autonomous engine ("autonomous").
 *
 * The chip is driven by `GET /api/bots/live` (see `lib/live-bots.ts`), which
 * the server scopes STRICTLY to this account — an engine running under a
 * different Deriv account is never listed here, so it can never appear
 * "active" on the wrong account.
 *
 * It is always rendered: when nothing is running it shows the idle
 * "No bot running" state (previously a separate widget inside the AI Bots
 * page), and when an engine is live it shows its name, P&L and Open/Stop
 * controls (previously a separate "Engine active" chip). Both merged into
 * this one, so nothing trades invisibly and there is never two popups.
 */

import { useEffect, useRef, useState } from "react";
import { Bot, X, StopCircle, Zap, Cpu } from "lucide-react";
import { toast } from "sonner";
import {
  stopPathForBot,
  stopBodyForBot,
  openPathForBot,
  OPEN_SPEED_AI_EVENT,
  type LiveBot,
} from "@/lib/live-bots";

function EngineIcon({ botId, className }: { botId: string; className?: string }) {
  if (botId === "neuroai") return <Zap className={className} />;
  if (botId === "autonomous") return <Cpu className={className} />;
  return <Bot className={className} />;
}

/** The metric line for the active engine: P&L when known, else today's trade count. */
function metricFor(s: LiveBot["status"]): { text: string; positive: boolean } | null {
  if (typeof s.totalProfit === "number") {
    return { text: `${s.totalProfit >= 0 ? "+" : "-"}$${Math.abs(s.totalProfit).toFixed(2)}`, positive: s.totalProfit >= 0 };
  }
  if (typeof s.tradesExecutedToday === "number") {
    return { text: `${s.tradesExecutedToday} trades today`, positive: true };
  }
  return null;
}

export function LiveBotIndicator({ compact = false, live }: { compact?: boolean; live: LiveBot[] }) {
  const [confirmStop, setConfirmStop] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const running = live.find(b => b.status?.running) ?? null;

  // ── Idle: the merged "No bot running" state (was a widget on the bots page) ──
  if (!running) {
    if (compact) {
      return (
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 flex-shrink-0" />
          <span className="text-[10px] font-medium text-muted-foreground/80">No bot running</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-[#080d17]/95 backdrop-blur px-3 py-2 shadow-xl shadow-black/40">
        <span className="w-2 h-2 rounded-full bg-muted-foreground/40 flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-[8px] uppercase tracking-wider text-muted-foreground flex items-center gap-1 leading-none">
            <Bot className="w-2.5 h-2.5" /> Active Engine
          </p>
          <p className="text-[11px] font-semibold text-muted-foreground/90 mt-0.5">No bot running</p>
        </div>
      </div>
    );
  }

  // ── Active: one engine per account (the arbiter caps execution at one) ─────
  const bot = running;
  const s = bot.status;
  const masked = s.masked === true;
  const name = s.botName ?? bot.botName;
  const metric = masked ? null : metricFor(s);
  const openPath = openPathForBot(bot.botId);

  const handleOpen = () => {
    if (bot.botId === "neuroai") {
      // The NeuroAI FAB button lives on every page — ask it to open its panel.
      window.dispatchEvent(new CustomEvent(OPEN_SPEED_AI_EVENT));
      return;
    }
    if (openPath) window.location.assign(openPath);
  };

  const handleStop = async () => {
    if (!confirmStop) {
      setConfirmStop(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmStop(false), 3500);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmStop(false);
    const body = stopBodyForBot(bot.botId);
    try {
      const res = await fetch(stopPathForBot(bot.botId), {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error((data?.error as string | undefined) ?? "Could not stop the engine");
        return;
      }
      toast.success(`${name} stopped`);
    } catch {
      toast.error("Could not stop the engine");
    }
  };

  if (compact) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-primary/30 bg-[#080d17]/90 pl-1.5 pr-2 py-1 shadow">
        <span className="relative flex w-2 h-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
        </span>
        <span className="text-[10px] font-semibold text-white/90 truncate max-w-[110px]">{name}</span>
        {metric && (
          <span className={`text-[10px] font-mono font-bold ${metric.positive ? "text-green-400" : "text-red-400"}`}>
            {metric.text}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-primary/30 bg-[#080d17]/95 backdrop-blur px-3 py-2 shadow-xl shadow-black/40">
      <span className="relative flex w-2 h-2 flex-shrink-0">
        <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60 animate-ping" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
      </span>
      <div className="min-w-0">
        <p className="text-[8px] uppercase tracking-wider text-muted-foreground flex items-center gap-1 leading-none">
          <EngineIcon botId={bot.botId} className="w-2.5 h-2.5" /> Live Engine
        </p>
        <p className="text-[11px] font-semibold text-white truncate max-w-[170px] mt-0.5">{name}</p>
      </div>
      {!masked && (
        <>
          {metric && (
            <span className={`text-xs font-mono font-bold flex-shrink-0 ${metric.positive ? "text-green-400" : "text-red-400"}`}>
              {metric.text}
            </span>
          )}
          {(openPath || bot.botId === "neuroai") && (
            <button
              onClick={handleOpen}
              className="flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline flex-shrink-0"
            >
              <EngineIcon botId={bot.botId} className="w-3 h-3" /> Open
            </button>
          )}
          <button
            onClick={handleStop}
            title={confirmStop ? "Click again to confirm" : "Stop this engine"}
            className={`flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 transition-colors ${
              confirmStop
                ? "bg-red-500/90 text-white"
                : "text-red-300 hover:bg-red-500/20"
            }`}
          >
            {confirmStop ? <X className="w-3 h-3" /> : <StopCircle className="w-3 h-3" />}
            {confirmStop ? "Sure?" : "Stop"}
          </button>
        </>
      )}
    </div>
  );
}

export default LiveBotIndicator;
