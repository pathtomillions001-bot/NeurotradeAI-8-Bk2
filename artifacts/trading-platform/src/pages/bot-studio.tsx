/**
 * Bot Studio — the vendored Deriv DBot builder, embedded in NeuroTrade.
 *
 * Same origin, same account, no second login:
 *   · the builder is served by this same app under `/bot/` (dev: Vite proxy →
 *     the builder's rsbuild server; prod: the web server serves the built files),
 *     so it shares the session cookie and localStorage with the platform;
 *   · it reads the account from `GET /api/dbot/session` and mints its trading
 *     connection from `GET /api/dbot/ws-url`, which resolves the platform's
 *     ACTIVE account — demo or real, exactly as selected in Settings.
 *
 * The iframe is lazy: the builder bundle is large (Blockly + SmartCharts), so it
 * must not load for users who never open Bot Studio.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import { Loader2, Puzzle, RefreshCw, AlertTriangle, ExternalLink, ShieldCheck, FlaskConical, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGetAccount } from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";
import { useDbotRunBridge } from "@/lib/dbot-run-bridge";

/**
 * Builder entry point — a SAME-ORIGIN path, deliberately never an absolute URL.
 *
 * Sharing the platform's origin is what lets the vendored builder read the
 * session and open already connected to the user's Deriv account; an absolute or
 * cross-origin URL would force a second login. Exported so
 * scripts/bot-studio-check.mjs can assert that contract.
 */
export const BOT_STUDIO_MOUNT = "/bot/";
const BUILDER_SRC = BOT_STUDIO_MOUNT;

export default function BotStudio() {
  const search = useSearch();
  const [frameKey, setFrameKey] = useState(0);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  // Workspace-only mode for an unconnected session: build, load and save
  // strategies with no account. Run stays inert because there is no trading
  // socket to buy through — nothing can be executed by accident.
  const [buildOnly, setBuildOnly] = useState(false);
  const [dbotRunning, setDbotRunning] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const { data: account } = useGetAccount({
    query: {
      retry: (count: number, err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return false;
        return count < 2;
      },
    },
  } as any);

  // Optional deep link: /bot-studio?load=<dbotId> (also ?dbot=<dbotId>, the
  // link "Create Deriv DBot" uses) preloads a generated bot.
  const dbotId = useMemo(() => {
    const params = new URLSearchParams(search);
    return params.get("load") ?? params.get("dbot") ?? "";
  }, [search]);
  const src = dbotId ? `${BUILDER_SRC}?load=${encodeURIComponent(dbotId)}` : BUILDER_SRC;

  // The app follows the tab: Run claims the account's engine lock + starts the
  // heartbeat that mirrors fills; Stop (here, in the badge, or on a demo/real
  // switch) releases it.
  useDbotRunBridge(dbotId || null, frameRef, setDbotRunning);

  // Give the host bridge to the builder before it boots, so its chrome can show
  // the same account the platform is on without an extra round trip.
  useEffect(() => {
    (window as any).__NEUROTRADE_HOST__ = {
      brandName: "NeuroTrade",
      connected: Boolean(account),
      accountType: account?.isVirtual ? "demo" : "real",
      accountId: account?.loginId,
    };
  }, [account]);

  // The builder posts its boot progress; surface failures instead of a blank box.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; message?: string } | undefined;
      if (!data?.type) return;
      if (data.type === "dbot:ready") { setReady(true); setBootError(null); }
      if (data.type === "dbot:error") setBootError(data.message ?? "The bot builder reported an error");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const reload = () => {
    setReady(false);
    setBootError(null);
    setFrameKey((k) => k + 1);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] min-h-[600px]">
      {/* ── Header: account binding, so the user can see WHERE bot trades land ── */}
      <div className="flex flex-wrap items-center gap-3 px-1 pb-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Puzzle className="w-5 h-5 text-primary" />
            Bot Studio
          </h1>
          <p className="text-xs text-muted-foreground">
            Build, load and run a Deriv DBot right here — connected to the same account as NeuroTrade.
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {account ? (
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-medium ${
                account.isVirtual
                  ? "bg-blue-500/10 border-blue-500/30 text-blue-300"
                  : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
              }`}
            >
              {account.isVirtual ? <FlaskConical className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              <span className="font-mono">{account.loginId}</span>
              <span className="uppercase tracking-wider">{account.isVirtual ? "Demo" : "Real"}</span>
              <span className="text-muted-foreground">
                {account.currency} {Number(account.balance ?? 0).toFixed(2)}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border bg-amber-500/10 border-amber-500/30 text-amber-300 text-xs font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              No Deriv account connected
            </div>
          )}

          {dbotRunning && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border bg-emerald-500/10 border-emerald-500/30 text-emerald-300 text-xs font-medium">
              <Activity className="w-3.5 h-3.5" />
              DBot running — fills mirror into your journal
            </div>
          )}

          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Reload builder
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={BUILDER_SRC} target="_blank" rel="noreferrer">
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
              Open full screen
            </a>
          </Button>
        </div>
      </div>

      {/* ── Not connected: explain, never show a second login form ── */}
      {!account && !buildOnly ? (
        <div className="flex-1 flex items-center justify-center rounded-lg border border-border bg-card">
          <div className="max-w-md text-center space-y-3 p-8">
            <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto" />
            <h2 className="font-semibold">Connect a Deriv account first</h2>
            <p className="text-sm text-muted-foreground">
              Bot Studio trades with the account you connect in NeuroTrade — demo or real, whichever you select.
              Connect once and the builder opens already signed in; you never log in twice.
            </p>
            <div className="flex items-center justify-center gap-2">
              <Button asChild>
                <a href="/connect">Go to Connect</a>
              </Button>
              <Button variant="outline" onClick={() => setBuildOnly(true)}>
                Build a bot without trading
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground pt-1">
              Building needs no account. Running does — the bot buys on your connected
              Deriv account (demo or real), so nothing can trade until you connect.
            </p>
          </div>
        </div>
      ) : (
        <div className="relative flex-1 rounded-lg border border-border overflow-hidden bg-card">
          {!ready && !buildOnly && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card z-10">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Loading the bot builder…</p>
            </div>
          )}
          {bootError && (
            <div className="absolute inset-x-0 top-0 z-20 bg-destructive/90 text-destructive-foreground text-xs px-3 py-2">
              {bootError}
            </div>
          )}
          {!account && buildOnly && (
            <div className="absolute inset-x-0 top-0 z-20 bg-amber-500/90 text-amber-950 text-xs px-3 py-1.5 font-medium">
              Workspace only — no account connected, so Run cannot trade. Connect a Deriv
              account to execute.
            </div>
          )}
          <iframe
            ref={frameRef}
            key={frameKey}
            src={src}
            title="Bot Studio — Deriv DBot builder"
            className="w-full h-full border-0"
            allow="clipboard-write"
            onLoad={() => setReady(true)}
          />
        </div>
      )}
    </div>
  );
}
