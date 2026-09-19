/**
 * The always-on "live bot" indicator — fixed to the top-right of every page.
 *
 * No bot may trade in the background without being visible: this chip is
 * driven by `GET /api/bots/live` (see `lib/live-bots.ts`), so ANY engine
 * running for the current session appears here within seconds (and instantly
 * via SSE), survives a page refresh (the poll re-runs on mount), and gives
 * the two things the user needs — OPEN the bot's live console, or STOP it.
 *
 * Engines owned by another browser session are masked by the API; the chip
 * then shows a plain "engine active" marker (no P&L, no controls).
 */

import { useEffect, useRef, useState } from "react";
import { Bot, X, StopCircle } from "lucide-react";
import { toast } from "sonner";
import { stopPathForBot, type LiveBot } from "@/lib/live-bots";

export function LiveBotIndicator({ compact = false, live }: { compact?: boolean; live: LiveBot[] }) {
  const [confirmStop, setConfirmStop] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  if (live.length === 0) return null;
  const bot = live[0]!;
  const s = bot.status;
  const masked = s.masked === true;
  const profit = s.totalProfit ?? 0;
  const name = s.botName ?? bot.botName;

  const handleStop = async () => {
    if (!confirmStop) {
      setConfirmStop(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmStop(false), 3500);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmStop(false);
    try {
      const res = await fetch(stopPathForBot(bot.botId), { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error((data?.error as string | undefined) ?? "Could not stop the bot");
        return;
      }
      toast.success(`${bot.botName} stopped`);
    } catch {
      toast.error("Could not stop the bot");
    }
  };

  if (compact) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-primary/30 bg-[#080d17]/90 pl-1.5 pr-2 py-1 shadow">
        <span className="relative flex w-2 h-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
        </span>
        <span className="text-[10px] font-semibold text-white/90 truncate max-w-[110px]">
          {masked ? "Engine active" : name}
        </span>
        {!masked && (
          <span className={`text-[10px] font-mono font-bold ${profit >= 0 ? "text-green-400" : "text-red-400"}`}>
            {profit >= 0 ? "+" : "-"}${Math.abs(profit).toFixed(2)}
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
          <Bot className="w-2.5 h-2.5" /> Live AI Bot
        </p>
        <p className="text-[11px] font-semibold text-white truncate max-w-[150px] mt-0.5">
          {masked ? "Engine active (another session)" : name}
        </p>
      </div>
      {!masked && (
        <>
          <span className={`text-xs font-mono font-bold flex-shrink-0 ${profit >= 0 ? "text-green-400" : "text-red-400"}`}>
            {profit >= 0 ? "+" : "-"}${Math.abs(profit).toFixed(2)}
          </span>
          <a
            href={`/bots?open=${bot.botId}`}
            className="flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline flex-shrink-0"
          >
            <Bot className="w-3 h-3" /> Open
          </a>
          <button
            onClick={handleStop}
            title={confirmStop ? "Click again to confirm" : "Stop this bot"}
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
