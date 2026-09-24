/**
 * DBot Studio — run scan-built Deriv bots INSIDE NeuroTrade.
 *
 * The page embeds the vendored Deriv bot builder (MIT fork served at /dbot)
 * and, through a same-origin postMessage bridge:
 *
 *   1. waits for the builder's workspace (nt:ready),
 *   2. hands it the user's connected Deriv account (nt:auth — the PAT the
 *      user already connected at /connect; nothing to paste, no redirect),
 *   3. uploads the strategy XML the API compiled from the bot scan
 *      (nt:load) — the bot appears in the builder in seconds,
 *   4. mirrors run state back into this header (nt:run / nt:stop).
 *
 * The user then presses the builder's Run button and trades are executed by
 * the Deriv DBot itself — visible in the builder's chart / transactions /
 * log panels — while NeuroTrade keeps showing the status here. Like every
 * DBot (including Deriv's own), execution lives in this browser tab: closing
 * it stops the bot.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  Bot, Hammer, Loader2, ShieldCheck, AlertTriangle, ArrowLeft,
  Play, StopCircle, Wallet, Blocks, Radio, Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const XML_KEY = "nt.dbot.xml";
const META_KEY = "nt.dbot.meta";

interface DbotMeta {
  botName?: string;
  filename?: string;
  summary?: {
    symbol: string;
    displayName: string;
    normal: string;
    recovery: string;
    currency: string;
    baseStake: number;
    takeProfit: number;
    stopLoss: number;
    recoveryMarkupPct: number;
    maxConsecutiveLosses: number;
    recoveryPayout: number;
    payoutSource: "live" | "fallback";
  };
  createdAt?: string;
}

type Phase =
  | "booting"        // iframe loading
  | "builder-ready"  // workspace up, account not yet injected
  | "authing"        // token handed over
  | "authed"         // account accepted
  | "loading-bot"    // xml being imported
  | "ready-to-run"   // strategy in workspace — user presses Run
  | "running"
  | "stopped"
  | "error";

interface SessionAccount {
  connected: boolean;
  loginId?: string;
  token?: string;
  currency?: string;
  isVirtual?: boolean;
}

export default function DbotStudio() {
  const [, navigate] = useLocation();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Read the hand-off synchronously: absent ⇒ show the empty state, never a spinner.
  const [xml] = useState<string>(
    () => window.sessionStorage.getItem(XML_KEY) ?? "",
  );
  const [meta] = useState<DbotMeta | null>(() => {
    try {
      const raw = window.sessionStorage.getItem(META_KEY);
      return raw ? (JSON.parse(raw) as DbotMeta) : null;
    } catch {
      return null;
    }
  });
  const [phase, setPhase] = useState<Phase>("booting");
  const [detail, setDetail] = useState<string>("");
  const [accountLabel, setAccountLabel] = useState<string>("");
  const [blocks, setBlocks] = useState<number>(0);
  const authRef = useRef(false);
  const loadRef = useRef(false);

  const post = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ source: "nt-host", ...msg }, "*");
  }, []);

  // Ping the builder until it answers (covers the race where its "ready"
  // fired before this page's listener attached — e.g. a fast cached reload).
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPinging = useCallback(() => {
    if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
  }, []);
  const onIframeLoad = useCallback(() => {
    stopPinging();
    pingRef.current = setInterval(() => post({ type: "nt:ping" }), 2000);
  }, [post, stopPinging]);
  useEffect(() => stopPinging, [stopPinging]);

  const injectAccount = useCallback(async () => {
    if (authRef.current) return;
    authRef.current = true;
    try {
      const res = await fetch("/api/bots/dbot/session", { credentials: "include" });
      const acc = (await res.json()) as SessionAccount;
      if (acc.connected && acc.token) {
        setPhase("authing");
        setDetail(`authorising ${acc.loginId}${acc.isVirtual ? " (demo)" : ""}…`);
        post({ type: "nt:auth", token: acc.token, loginId: acc.loginId });
      } else {
        setAccountLabel("");
        setDetail("No Deriv account connected — the bot will load, you can log in inside the builder.");
        // No account: still load the strategy so the user can review it.
        loadRef.current = true;
        setPhase("loading-bot");
        if (xml) post({ type: "nt:load", xml, name: meta?.filename });
      }
    } catch {
      setDetail("Could not reach the account service — the bot will load without an account.");
      loadRef.current = true;
      setPhase("loading-bot");
      if (xml) post({ type: "nt:load", xml, name: meta?.filename });
    }
  }, [post, xml, meta]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string } & Record<string, unknown>;
      if (!data || data.source !== "nt-dbot" || typeof data.type !== "string") return;
      stopPinging();

      switch (data.type) {
        case "nt:pong":
          // Builder answered a ping but hasn't said ready — treat as alive and connect.
          if (!authRef.current && !loadRef.current) void injectAccount();
          break;
        case "nt:ready":
          setPhase("builder-ready");
          setDetail("builder workspace ready");
          void injectAccount();
          break;
        case "nt:auth:ok": {
          const login = String(data.loginId ?? "");
          const virt = data.isVirtual ? " (demo)" : "";
          setAccountLabel(`${login}${virt}`);
          setPhase("loading-bot");
          setDetail("account linked — building your bot…");
          loadRef.current = true;
          if (xml) post({ type: "nt:load", xml, name: meta?.filename });
          break;
        }
        case "nt:auth:error":
          setPhase("loading-bot");
          setDetail(`login failed (${String(data.message ?? "unknown")}) — log in inside the builder instead`);
          loadRef.current = true;
          if (xml) post({ type: "nt:load", xml, name: meta?.filename });
          break;
        case "nt:loaded":
          setBlocks(Number(data.blocks ?? 0));
          setPhase("ready-to-run");
          setDetail("bot built — press RUN in the builder below");
          break;
        case "nt:load:error":
          setPhase("error");
          setDetail(String(data.message ?? "the builder rejected the strategy"));
          break;
        case "nt:run":
          setPhase("running");
          setDetail("the Deriv DBot is trading — keep this tab open");
          break;
        case "nt:stop":
          setPhase("stopped");
          setDetail("bot stopped");
          break;
        case "nt:error":
          setDetail(String(data.message ?? ""));
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [injectAccount, post, xml, meta]);

  const downloadXml = () => {
    if (!xml) return;
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = meta?.filename ?? "neurotrade-bot.xml";
    a.click();
    URL.revokeObjectURL(url);
  };

  const s = meta?.summary;
  const ready = phase === "ready-to-run" || phase === "running" || phase === "stopped";

  if (xml === "") {
    return (
      <div className="p-6 max-w-lg mx-auto mt-10 rounded-2xl border border-border bg-secondary/20 space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h1 className="text-sm font-bold">No bot was handed to the studio</h1>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Run a scan in a bot console and press <span className="text-white font-semibold">Create DBot</span>.
          The analysed bot is delivered here automatically.
        </p>
        <Button variant="outline" size="sm" onClick={() => navigate("/bots")}>
          <ArrowLeft className="w-3.5 h-3.5 mr-2" /> Back to Bots
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-7rem)] md:h-[calc(100dvh-4rem)] p-2 md:p-3 gap-2">
      {/* Header / status rail */}
      <div className="rounded-xl border border-border bg-secondary/20 px-3 py-2 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => navigate("/bots")}>
            <ArrowLeft className="w-3.5 h-3.5" />
          </Button>
          <div className="flex items-center gap-1.5">
            <Hammer className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-bold tracking-wide">DBot Studio</span>
          </div>
          {s && (
            <span className="text-[11px] text-muted-foreground truncate">
              {meta?.botName ?? "Over/Under Turbo"} · {s.displayName} · {s.normal} → {s.recovery}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {xml && (
              <button
                onClick={downloadXml}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-white transition-colors"
                title="Download the generated strategy XML"
              >
                <Download className="w-3 h-3" /> XML
              </button>
            )}
            <PhaseChip phase={phase} />
          </div>
        </div>

        {s && (
          <div className="flex items-center gap-3 flex-wrap text-[10px] font-mono text-muted-foreground">
            <span>stake <b className="text-white/90">{s.currency} {s.baseStake.toFixed(2)}</b></span>
            <span>TP <b className="text-green-400">{s.takeProfit.toFixed(2)}</b></span>
            <span>SL <b className="text-red-400">{s.stopLoss.toFixed(2)}</b></span>
            <span>markup <b className="text-white/90">{s.recoveryMarkupPct}%</b></span>
            <span>payout <b className="text-white/90">×{s.recoveryPayout.toFixed(4)}</b>{s.payoutSource === "fallback" ? " (schedule)" : ""}</span>
            <span>breaker <b className="text-white/90">{s.maxConsecutiveLosses} losses</b></span>
            {blocks > 0 && <span className="text-sky-300"><Blocks className="inline w-3 h-3 mr-1" />{blocks} blocks</span>}
          </div>
        )}

        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <ShieldCheck className={`w-3.5 h-3.5 ${accountLabel ? "text-green-400" : "text-muted-foreground/50"}`} />
            {accountLabel ? `Account ${accountLabel}` : "Builder login available inside"}
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground truncate">
            {phase === "running" && <Radio className="w-3.5 h-3.5 text-green-400 animate-pulse" />}
            <span className="truncate">{detail}</span>
          </span>
        </div>
      </div>

      {/* The builder itself */}
      <div className="relative flex-1 rounded-xl border border-border overflow-hidden bg-white min-h-[320px]">
        {!ready && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/70 backdrop-blur-sm pointer-events-none">
            {phase === "error" ? (
              <AlertTriangle className="w-6 h-6 text-amber-400" />
            ) : (
              <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
            )}
            <p className="text-xs text-muted-foreground max-w-xs text-center px-4">
              {phase === "error" ? detail : "Assembling your Deriv bot in the visual builder…"}
            </p>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src="/dbot/index.html"
          title="Deriv bot builder"
          className="w-full h-full border-0"
          allow="clipboard-read; clipboard-write"
          onLoad={onIframeLoad}
        />
      </div>

      <p className="text-[9px] text-muted-foreground/70 leading-relaxed px-1">
        Trades are placed by the Deriv DBot running in this tab — keep it open to keep trading
        (closing it stops the bot, same as Deriv's own builder). Balances and fills always match
        your Deriv account. Review the blocks before pressing <Play className="inline w-2.5 h-2.5" /> / <StopCircle className="inline w-2.5 h-2.5" />.
        <Bot className="inline w-3 h-3 ml-1 opacity-60" />
        <Wallet className="inline w-3 h-3 ml-1 opacity-60" />
      </p>
    </div>
  );
}

function PhaseChip({ phase }: { phase: Phase }) {
  const map: Record<Phase, { label: string; cls: string; pulse?: boolean }> = {
    "booting": { label: "Builder starting", cls: "text-muted-foreground border-border" },
    "builder-ready": { label: "Builder ready", cls: "text-sky-300 border-sky-500/40", pulse: true },
    "authing": { label: "Linking account", cls: "text-sky-300 border-sky-500/40", pulse: true },
    "authed": { label: "Account linked", cls: "text-green-300 border-green-500/40" },
    "loading-bot": { label: "Building bot", cls: "text-sky-300 border-sky-500/40", pulse: true },
    "ready-to-run": { label: "Ready — press RUN", cls: "text-green-300 border-green-500/40" },
    "running": { label: "DBot trading", cls: "text-green-300 border-green-500/40", pulse: true },
    "stopped": { label: "Stopped", cls: "text-amber-300 border-amber-500/40" },
    "error": { label: "Load issue", cls: "text-amber-300 border-amber-500/40" },
  };
  const c = map[phase];
  return (
    <span className={`flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-full border bg-black/30 ${c.cls}`}>
      {c.pulse && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
      {c.label}
    </span>
  );
}
