/**
 * THE bot status popup — the one element that answers "is a bot trading, and
 * is it trading THIS account?".
 *
 * It replaces TWO elements that used to say different things:
 *
 *   1. the floating "Live AI Bot" chip in the layout (only rendered when a bot
 *      ran, and it never mentioned an account), and
 *   2. the "Active Bot / No bot running" badge in the Bot Arena header (which
 *      read a different endpoint, so the two could disagree).
 *
 * One component, one source (`useLiveBotsState`, i.e. `GET /api/bots/live`),
 * four states:
 *
 *   idle          — nothing running: "No bot running" (the Bot Arena's old
 *                   badge, now in the same element as the rest).
 *   active        — a bot trading the account this browser is connected to.
 *                   Shows the account next to the name so the claim is
 *                   checkable.
 *   other-account — a bot running for this browser on a DIFFERENT linked
 *                   Deriv account. It is amber, it names that account, and it
 *                   never claims to be this account's bot — but it stays
 *                   visible and stoppable, because hiding a live engine is the
 *                   one failure this subsystem exists to prevent.
 *   other-session — another browser session's engine: masked marker, no
 *                   telemetry (the API masks it).
 */

import { useEffect, useRef, useState } from "react";
import { Bot, X, StopCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  otherAccountBot, otherSessionBot, ownAccountBot, stopPathForBot,
  useLiveBotsState, type LiveBot,
} from "@/lib/live-bots";

type Tone = "active" | "foreign" | "masked" | "idle";

interface Panel {
  tone: Tone;
  /** Small uppercase label above the name. */
  kicker: string;
  /** Primary line. */
  title: string;
  /** Optional secondary line: the account context. */
  detail?: string;
  profit?: number;
  botId?: string;
  botName?: string;
  stoppable: boolean;
}

const SHELL: Record<Tone, string> = {
  active: "border-green-500/40 bg-[#080d17]/95",
  foreign: "border-amber-500/50 bg-[#0d0b05]/95",
  masked: "border-primary/30 bg-[#080d17]/95",
  idle: "border-border bg-[#080d17]/90",
};

const DOT: Record<Tone, string> = {
  active: "bg-green-400",
  foreign: "bg-amber-400",
  masked: "bg-primary",
  idle: "bg-muted-foreground/50",
};

function panelFor(bots: LiveBot[], account: string | null, showIdle: boolean): Panel | null {
  const own = ownAccountBot(bots);
  if (own) {
    const profit = own.status.totalProfit ?? 0;
    return {
      tone: "active",
      kicker: "Live AI Bot",
      title: own.status.botName ?? own.botName,
      detail: account ? `Trading ${account}` : undefined,
      profit,
      botId: own.botId,
      botName: own.botName,
      stoppable: true,
    };
  }

  // A bot on another linked account is NOT this account's bot. It gets its own
  // state rather than the active treatment, and it names the account it is on.
  const foreign = otherAccountBot(bots);
  if (foreign) {
    const on = foreign.account ?? "another Deriv account";
    return {
      tone: "foreign",
      kicker: "Running elsewhere",
      title: account ? `Bot active on ${on}` : `Bot active on ${on}`,
      detail: account
        ? `This account is ${account} — switch back to see its P&L`
        : `No account is connected here`,
      profit: foreign.status.totalProfit ?? 0,
      botId: foreign.botId,
      botName: foreign.botName,
      stoppable: true,
    };
  }

  const masked = otherSessionBot(bots);
  if (masked) {
    return {
      tone: "masked",
      kicker: "Live AI Bot",
      title: "Engine active (another session)",
      detail: "Another browser session is trading its own account",
      botId: masked.botId,
      botName: masked.botName,
      stoppable: false,
    };
  }

  if (!showIdle) return null;
  return {
    tone: "idle",
    kicker: "AI Bot Arena",
    title: "No bot running",
    detail: "Open a bot to start trading",
    stoppable: false,
  };
}

export function BotStatusPopup({ compact = false, showIdle = false }: {
  compact?: boolean;
  /** Render the idle state too (the Bot Arena). Elsewhere idle is silent. */
  showIdle?: boolean;
}) {
  const { bots, account } = useLiveBotsState();
  const [confirmStop, setConfirmStop] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const panel = panelFor(bots, account, showIdle);
  // A stop confirmation must not survive the bot leaving.
  useEffect(() => {
    if (!panel || !panel.stoppable) setConfirmStop(false);
  }, [panel?.botId, panel?.stoppable]);
  if (!panel) return null;

  const handleStop = async () => {
    if (!panel.botId) return;
    if (!confirmStop) {
      setConfirmStop(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmStop(false), 3500);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmStop(false);
    try {
      const res = await fetch(stopPathForBot(panel.botId), { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error((data?.error as string | undefined) ?? "Could not stop the bot");
        return;
      }
      toast.success(`${panel.botName ?? panel.botId} stopped`);
    } catch {
      toast.error("Could not stop the bot");
    }
  };

  const pulsing = panel.tone === "active" || panel.tone === "foreign";

  if (compact) {
    return (
      <div className={`flex items-center gap-2 rounded-full border pl-1.5 pr-2 py-1 shadow ${SHELL[panel.tone]}`}>
        <span className="relative flex w-2 h-2 flex-shrink-0">
          {pulsing && (
            <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${DOT[panel.tone]}`} />
          )}
          <span className={`relative inline-flex rounded-full h-2 w-2 ${DOT[panel.tone]}`} />
        </span>
        {panel.tone === "foreign" && <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />}
        <span className={`text-[10px] font-semibold truncate max-w-[130px] ${
          panel.tone === "foreign" ? "text-amber-200"
            : panel.tone === "idle" ? "text-muted-foreground"
              : "text-white/90"}`}>
          {panel.title}
        </span>
        {panel.profit !== undefined && panel.tone !== "idle" && (
          <span className={`text-[10px] font-mono font-bold ${panel.profit >= 0 ? "text-green-400" : "text-red-400"}`}>
            {panel.profit >= 0 ? "+" : "-"}${Math.abs(panel.profit).toFixed(2)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2.5 rounded-xl border backdrop-blur px-3 py-2 shadow-xl shadow-black/40 max-w-[min(92vw,26rem)] ${SHELL[panel.tone]}`}>
      <span className="relative flex w-2 h-2 flex-shrink-0">
        {pulsing && (
          <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${DOT[panel.tone]}`} />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${DOT[panel.tone]}`} />
      </span>
      <div className="min-w-0">
        <p className={`text-[8px] uppercase tracking-wider flex items-center gap-1 leading-none ${
          panel.tone === "foreign" ? "text-amber-400/90" : "text-muted-foreground"}`}>
          {panel.tone === "foreign" ? <AlertTriangle className="w-2.5 h-2.5" /> : <Bot className="w-2.5 h-2.5" />}
          {panel.kicker}
        </p>
        <p className={`text-[11px] font-semibold truncate max-w-[190px] mt-0.5 ${
          panel.tone === "foreign" ? "text-amber-200"
            : panel.tone === "idle" ? "text-muted-foreground"
              : "text-white"}`}>
          {panel.title}
        </p>
        {panel.detail && (
          <p className="text-[9px] text-muted-foreground/80 truncate max-w-[230px] mt-0.5">{panel.detail}</p>
        )}
      </div>
      {panel.profit !== undefined && panel.tone !== "idle" && (
        <span className={`text-xs font-mono font-bold flex-shrink-0 ${panel.profit >= 0 ? "text-green-400" : "text-red-400"}`}>
          {panel.profit >= 0 ? "+" : "-"}${Math.abs(panel.profit).toFixed(2)}
        </span>
      )}
      {panel.botId && (
        <a
          href={`/bots?open=${panel.botId}`}
          className={`flex items-center gap-1 text-[10px] font-semibold hover:underline flex-shrink-0 ${
            panel.tone === "foreign" ? "text-amber-300" : "text-primary"}`}
        >
          <Bot className="w-3 h-3" /> Open
        </a>
      )}
      {panel.stoppable && (
        <button
          onClick={handleStop}
          title={confirmStop ? "Click again to confirm" : "Stop this bot"}
          className={`flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 transition-colors ${
            confirmStop ? "bg-red-500/90 text-white" : "text-red-300 hover:bg-red-500/20"}`}
        >
          {confirmStop ? <X className="w-3 h-3" /> : <StopCircle className="w-3 h-3" />}
          {confirmStop ? "Sure?" : "Stop"}
        </button>
      )}
    </div>
  );
}

export default BotStatusPopup;
