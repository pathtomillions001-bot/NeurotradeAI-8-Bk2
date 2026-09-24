/**
 * Deriv Bot Builder page — visual strategy builder powered by Deriv DBot.
 *
 * Supports two workflows:
 *   1. Scanner hand-off: When coming from Over/Under Turbo (or other scanner)
 *      via "Create DBot", the strategy XML compiled by the backend is auto-loaded
 *      into the Blockly workspace in seconds with the exact market, contracts,
 *      debt recovery logic, TP/SL, and stake parameters.
 *   2. Standalone builder: Accessible anytime from the main navigation, letting
 *      the user build, inspect, edit, import/export, and run any Deriv trading bot.
 *
 * Automatically synchronizes the active Deriv account (Demo or Real) and API token.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  Blocks,
  ShieldCheck,
  AlertTriangle,
  ArrowLeft,
  Play,
  StopCircle,
  Download,
  Loader2,
  Radio,
  ExternalLink,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGetAccount } from "@workspace/api-client-react";

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
  | "builder-ready"  // workspace up
  | "authing"        // credentials being injected
  | "authed"         // account accepted
  | "loading-bot"    // xml being imported into workspace
  | "ready-to-run"   // ready — user can inspect and press Run
  | "running"        // bot actively executing trades
  | "stopped"        // bot stopped
  | "error";

interface SessionAccount {
  connected: boolean;
  loginId?: string;
  token?: string;
  currency?: string;
  balance?: number;
  isVirtual?: boolean;
}

export default function BotBuilderPage() {
  const [, navigate] = useLocation();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [xml, setXml] = useState<string>(
    () => window.sessionStorage.getItem(XML_KEY) ?? "",
  );
  const [meta, setMeta] = useState<DbotMeta | null>(() => {
    try {
      const raw = window.sessionStorage.getItem(META_KEY);
      return raw ? (JSON.parse(raw) as DbotMeta) : null;
    } catch {
      return null;
    }
  });

  const [phase, setPhase] = useState<Phase>("booting");
  const [detail, setDetail] = useState<string>("Initializing Deriv Bot Builder…");
  const [accountLabel, setAccountLabel] = useState<string>("");
  const [blocks, setBlocks] = useState<number>(0);
  const authRef = useRef(false);
  const loadRef = useRef(false);

  const { data: activeAccount } = useGetAccount({
    query: {
      refetchInterval: 10_000,
    },
  } as any);

  const post = useCallback((msg: Record<string, unknown>) => {
    try {
      iframeRef.current?.contentWindow?.postMessage({ source: "nt-host", ...msg }, "*");
    } catch {}
  }, []);

  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPinging = useCallback(() => {
    if (pingRef.current) {
      clearInterval(pingRef.current);
      pingRef.current = null;
    }
  }, []);

  const onIframeLoad = useCallback(() => {
    stopPinging();
    pingRef.current = setInterval(() => post({ type: "nt:ping" }), 1500);
  }, [post, stopPinging]);

  useEffect(() => stopPinging, [stopPinging]);

  const injectAccount = useCallback(async () => {
    try {
      const res = await fetch("/api/bots/dbot/session", { credentials: "include" });
      const acc = (await res.json()) as SessionAccount;
      if (acc.connected && acc.token && acc.loginId) {
        setPhase("authing");
        setDetail(`Authorizing ${acc.loginId}${acc.isVirtual ? " (Demo)" : " (Real)"}…`);
        post({
          type: "nt:auth",
          token: acc.token,
          loginId: acc.loginId,
          isVirtual: acc.isVirtual,
          currency: acc.currency,
          balance: acc.balance,
        });
      } else {
        setAccountLabel("");
        setDetail("Ready — Connect your account in Settings or use inside builder");
        if (xml && !loadRef.current) {
          loadRef.current = true;
          setPhase("loading-bot");
          post({ type: "nt:load", xml, name: meta?.filename });
        } else {
          setPhase("builder-ready");
        }
      }
    } catch {
      setDetail("Ready — builder active");
      if (xml && !loadRef.current) {
        loadRef.current = true;
        setPhase("loading-bot");
        post({ type: "nt:load", xml, name: meta?.filename });
      } else {
        setPhase("builder-ready");
      }
    }
  }, [post, xml, meta]);

  // Synchronize when the user changes active account in NeuroTrade
  useEffect(() => {
    if (activeAccount?.loginId) {
      void injectAccount();
    }
  }, [activeAccount?.loginId, injectAccount]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string } & Record<string, unknown>;
      if (!data || data.source !== "nt-dbot" || typeof data.type !== "string") return;
      stopPinging();

      switch (data.type) {
        case "nt:pong":
          if (!authRef.current) {
            authRef.current = true;
            void injectAccount();
          }
          break;
        case "nt:ready":
          setPhase("builder-ready");
          setDetail("Workspace ready");
          if (!authRef.current) {
            authRef.current = true;
            void injectAccount();
          }
          break;
        case "nt:auth:ok": {
          const login = String(data.loginId ?? "");
          const virt = data.isVirtual ? " (Demo)" : " (Real)";
          setAccountLabel(`${login}${virt}`);
          if (xml && !loadRef.current) {
            loadRef.current = true;
            setPhase("loading-bot");
            setDetail("Account linked — populating bot blocks in seconds…");
            post({ type: "nt:load", xml, name: meta?.filename });
          } else {
            setPhase("builder-ready");
            setDetail(`Account ${login}${virt} connected`);
          }
          break;
        }
        case "nt:auth:error":
          if (xml && !loadRef.current) {
            loadRef.current = true;
            setPhase("loading-bot");
            post({ type: "nt:load", xml, name: meta?.filename });
          }
          break;
        case "nt:loaded":
          setBlocks(Number(data.blocks ?? 0));
          setPhase("ready-to-run");
          setDetail("Bot built successfully — click RUN in the builder to trade");
          break;
        case "nt:load:error":
          setPhase("error");
          setDetail(String(data.message ?? "The builder could not import the strategy"));
          break;
        case "nt:run":
          setPhase("running");
          setDetail("Deriv DBot is trading live — keep this tab open");
          break;
        case "nt:stop":
          setPhase("stopped");
          setDetail("Bot execution stopped");
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [injectAccount, post, xml, meta, stopPinging]);

  const clearLoadedBot = () => {
    window.sessionStorage.removeItem(XML_KEY);
    window.sessionStorage.removeItem(META_KEY);
    setXml("");
    setMeta(null);
    setBlocks(0);
    setPhase("builder-ready");
    setDetail("Standard Deriv workspace active");
  };

  const downloadXml = () => {
    if (!xml) return;
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = meta?.filename ?? "neurotrade-dbot.xml";
    a.click();
    URL.revokeObjectURL(url);
  };

  const s = meta?.summary;
  const isReady = phase === "ready-to-run" || phase === "running" || phase === "stopped" || phase === "builder-ready";

  return (
    <div className="flex flex-col h-[calc(100dvh-4.5rem)] md:h-[calc(100dvh-3.5rem)] p-2 md:p-3 gap-2">
      {/* Top Banner / Status Rail */}
      <div className="rounded-xl border border-border bg-card/60 backdrop-blur-sm px-3 py-2 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => navigate("/bots")}
            title="Back to AI Bots"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </Button>

          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Blocks className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-white flex items-center gap-1.5">
                Deriv Bot Builder
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-primary/20 text-primary border border-primary/30 font-medium">
                  Official DBot
                </span>
              </h1>
            </div>
          </div>

          {s && (
            <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground ml-2 pl-3 border-l border-white/10">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span className="font-semibold text-white/90">{s.displayName}</span>
              <span>·</span>
              <span className="font-mono text-cyan-400">{s.normal}</span>
              <span>→</span>
              <span className="font-mono text-amber-400">{s.recovery}</span>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            {xml && (
              <>
                <button
                  onClick={downloadXml}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border bg-secondary/30 text-muted-foreground hover:text-white transition-colors"
                  title="Download strategy XML"
                >
                  <Download className="w-3 h-3" /> XML
                </button>
                <button
                  onClick={clearLoadedBot}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border bg-secondary/30 text-muted-foreground hover:text-white transition-colors"
                  title="Reset to blank workspace"
                >
                  <RefreshCw className="w-3 h-3" /> Reset
                </button>
              </>
            )}
            <PhaseChip phase={phase} />
          </div>
        </div>

        {/* Metrics Bar when strategy is loaded from scanner */}
        {s && (
          <div className="flex items-center gap-3 flex-wrap text-[10px] font-mono text-muted-foreground bg-secondary/20 rounded-lg px-2.5 py-1.5 border border-white/5">
            <span>Market: <b className="text-white">{s.displayName} ({s.symbol})</b></span>
            <span>Normal: <b className="text-cyan-300">{s.normal}</b></span>
            <span>Recovery: <b className="text-amber-300">{s.recovery}</b></span>
            <span>Stake: <b className="text-white">{s.currency} {s.baseStake.toFixed(2)}</b></span>
            <span>TP: <b className="text-green-400">+{s.takeProfit.toFixed(2)}</b></span>
            <span>SL: <b className="text-red-400">-{s.stopLoss.toFixed(2)}</b></span>
            <span>Markup: <b className="text-white">{s.recoveryMarkupPct}%</b></span>
            <span>Recovery Payout: <b className="text-white">×{s.recoveryPayout.toFixed(2)}</b></span>
            <span>Circuit Breaker: <b className="text-white">{s.maxConsecutiveLosses} max losses</b></span>
            {blocks > 0 && <span className="text-sky-300 font-bold">({blocks} blocks loaded)</span>}
          </div>
        )}

        {/* Account and Live Status info */}
        <div className="flex items-center justify-between text-[11px] gap-2 pt-0.5">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <ShieldCheck className={`w-3.5 h-3.5 ${accountLabel ? "text-green-400" : "text-muted-foreground/60"}`} />
              {accountLabel ? (
                <span className="font-mono text-white/90">
                  Trading Account: <b className="text-green-400">{accountLabel}</b>
                </span>
              ) : (
                <span>No account connected (connect in Settings)</span>
              )}
            </span>
          </div>

          <div className="flex items-center gap-2 text-muted-foreground">
            {phase === "running" && <Radio className="w-3.5 h-3.5 text-green-400 animate-pulse" />}
            <span className="truncate">{detail}</span>
          </div>
        </div>
      </div>

      {/* Embedded Deriv Bot Workspace */}
      <div className="relative flex-1 rounded-xl border border-border overflow-hidden bg-[#0e1117] min-h-[400px]">
        {!isReady && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm pointer-events-none">
            {phase === "error" ? (
              <AlertTriangle className="w-6 h-6 text-amber-400" />
            ) : (
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            )}
            <p className="text-xs text-muted-foreground max-w-sm text-center px-4">
              {phase === "error" ? detail : "Loading Deriv Bot Builder workspace…"}
            </p>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src="/dbot/index.html#bot_builder"
          title="Deriv Bot Builder"
          className="w-full h-full border-0"
          allow="clipboard-read; clipboard-write"
          onLoad={onIframeLoad}
        />
      </div>

      {/* Bottom Hint */}
      <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground/70">
        <span>
          Visual blocks can be customized freely. Click <Play className="inline w-2.5 h-2.5 mx-0.5 text-green-400" /> <b>Run</b> in the builder to execute trades directly on Deriv.
        </span>
        <span className="hidden sm:inline">
          Connected directly to Deriv API · All trades sync to NeuroTrade Journal
        </span>
      </div>
    </div>
  );
}

function PhaseChip({ phase }: { phase: Phase }) {
  const map: Record<Phase, { label: string; cls: string; pulse?: boolean }> = {
    booting: { label: "Starting Builder", cls: "text-muted-foreground border-border" },
    "builder-ready": { label: "Workspace Ready", cls: "text-sky-300 border-sky-500/40" },
    authing: { label: "Syncing Account", cls: "text-sky-300 border-sky-500/40", pulse: true },
    authed: { label: "Account Linked", cls: "text-green-300 border-green-500/40" },
    "loading-bot": { label: "Loading Blocks", cls: "text-sky-300 border-sky-500/40", pulse: true },
    "ready-to-run": { label: "Ready — Press RUN", cls: "text-green-400 border-green-500/50 bg-green-500/10" },
    running: { label: "DBot Trading Live", cls: "text-green-300 border-green-500/50 bg-green-500/10", pulse: true },
    stopped: { label: "Stopped", cls: "text-amber-300 border-amber-500/40" },
    error: { label: "Error", cls: "text-red-400 border-red-500/40" },
  };
  const c = map[phase];
  return (
    <span className={`flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-black/40 ${c.cls}`}>
      {c.pulse && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
      {c.label}
    </span>
  );
}
