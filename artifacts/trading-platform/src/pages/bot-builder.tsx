/**
 * Bot Builder — the embedded Deriv DBot workspace.
 *
 * The frame is served from our own origin (/dbot/, embed mode) so it shares
 * localStorage: we seed the Deriv token of the account active in NeuroTrade
 * and DBot boots already authorized on exactly that account (demo or real).
 * The frame posts contract/run-state events back; we journal them into our
 * trades table + recovery ledger and mirror execution ownership in the
 * engine arbiter, so DBot and our server engines never trade at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Blocks, CircleStop, Play, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DBOT_FRAME_SOURCE,
  fetchBridgeToken,
  fetchStrategies,
  fetchStrategy,
  postContractEvent,
  postRunState,
  postToFrame,
  seedDbotAuth,
  type BridgeToken,
  type DbotStrategySummary,
} from "@/lib/dbot";

interface FrameAccount {
  loginid: string;
  currency: string;
  is_virtual: boolean;
}

export default function BotBuilder() {
  const [location, setLocation] = useLocation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [token, setToken] = useState<BridgeToken | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [account, setAccount] = useState<FrameAccount | null>(null);
  const [strategies, setStrategies] = useState<DbotStrategySummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loadingXml, setLoadingXml] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const pendingStrategy = useRef<number | null>(null);

  const requestedStrategy = useMemo(() => {
    const m = /[?&]strategy=(\d+)/.exec(location);
    return m ? Number(m[1]) : null;
  }, [location]);

  const refreshStrategies = useCallback(() => {
    fetchStrategies()
      .then(setStrategies)
      .catch(() => setStrategies([]));
  }, []);

  // Seed auth BEFORE the frame boots; the iframe then reads the same storage.
  useEffect(() => {
    let alive = true;
    fetchBridgeToken()
      .then((t) => {
        if (!alive) return;
        seedDbotAuth(t);
        setToken(t);
        setAuthError(null);
      })
      .catch((err: Error) => {
        if (!alive) return;
        setAuthError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [frameKey]);

  useEffect(() => {
    refreshStrategies();
  }, [refreshStrategies]);

  useEffect(() => {
    if (requestedStrategy) {
      pendingStrategy.current = requestedStrategy;
      setSelected(requestedStrategy);
      // strip the query so refreshes don't reload repeatedly
      setLocation("/bot-builder", { replace: true } as never);
    }
  }, [requestedStrategy, setLocation]);

  const loadStrategy = useCallback(
    async (id: number) => {
      if (!frameReady) {
        pendingStrategy.current = id;
        return;
      }
      setLoadingXml(true);
      try {
        const strat = await fetchStrategy(id);
        postToFrame(frameRef.current, { type: "nt:load-xml", xml: strat.xml, name: `${strat.name}.xml` });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not load the strategy");
      } finally {
        setLoadingXml(false);
      }
    },
    [frameReady],
  );

  // Frame → platform protocol.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Record<string, any> | null;
      if (!data || data.source !== DBOT_FRAME_SOURCE) return;

      switch (data.type) {
        case "nt:ready": {
          setFrameReady(true);
          setAccount(data.account as FrameAccount);
          // Parity guard: the frame must be on the account WE seeded.
          if (token && data.account?.loginid && data.account.loginid !== token.loginid) {
            seedDbotAuth(token);
            setFrameKey((k) => k + 1);
            setFrameReady(false);
            toast.warning("Re-synced the builder to your active NeuroTrade account");
            return;
          }
          const pending = pendingStrategy.current;
          if (pending) {
            pendingStrategy.current = null;
            void loadStrategy(pending);
          }
          break;
        }
        case "nt:run-state": {
          setRunning(Boolean(data.running));
          void postRunState(Boolean(data.running));
          break;
        }
        case "nt:contract": {
          void postContractEvent(data.contract, data.stage === "settled" ? "settled" : "open");
          break;
        }
        case "nt:loaded": {
          if (data.ok) toast.success("Strategy loaded into the builder — press Run when ready");
          else toast.error(`Builder rejected the strategy: ${data.error ?? "unknown error"}`);
          break;
        }
        case "nt:auth-lost": {
          toast.warning("Deriv session expired — re-syncing your connected account");
          setFrameKey((k) => k + 1);
          setFrameReady(false);
          break;
        }
        case "nt:error": {
          toast.error(`Builder: ${data.error ?? "unknown error"}`);
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [token, loadStrategy]);

  const demoReal = token?.accountType === "demo" ? "DEMO" : token?.accountType === "real" ? "REAL" : "—";

  return (
    <div className="flex flex-col h-full gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Blocks className="w-5 h-5 text-cyan-400" />
          <h1 className="text-lg font-bold">Bot Builder</h1>
        </div>
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded ${
            token?.accountType === "real" ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300"
          }`}
          title="The builder trades with exactly this account"
        >
          {demoReal} {account?.loginid ?? token?.loginid ?? ""}
        </span>
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded ${
            running ? "bg-emerald-500/20 text-emerald-300" : "bg-zinc-500/20 text-zinc-300"
          }`}
        >
          {running ? "DBOT RUNNING" : "IDLE"}
        </span>

        <div className="flex-1" />

        <select
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs max-w-[260px]"
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Saved strategies…</option>
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={!selected || loadingXml} onClick={() => selected && loadStrategy(selected)}>
          {loadingXml ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          <span className="ml-1">Load</span>
        </Button>
        <Button size="sm" variant="outline" disabled={!frameReady} onClick={() => postToFrame(frameRef.current, { type: "nt:run" })}>
          <Play className="w-4 h-4" />
          <span className="ml-1">Run</span>
        </Button>
        <Button size="sm" variant="outline" disabled={!frameReady || !running} onClick={() => postToFrame(frameRef.current, { type: "nt:stop" })}>
          <CircleStop className="w-4 h-4" />
          <span className="ml-1">Stop</span>
        </Button>
      </div>

      {authError && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          {authError}
        </div>
      )}

      <div className="flex-1 min-h-[420px] rounded border border-zinc-800 overflow-hidden bg-white">
        {token && (
          <iframe
            key={frameKey}
            ref={frameRef}
            title="Deriv DBot Builder"
            src="/dbot/?embed=1"
            className="w-full h-full border-0"
          />
        )}
      </div>

      <p className="text-[11px] text-zinc-500">
        Trades executed here run through Deriv&apos;s own DBot engine on your connected {demoReal} account.
        Every contract is journaled into your NeuroTrade Journal and recovery ledger. While the DBot runs,
        the server-side engines pause (single-executor rule).
      </p>
    </div>
  );
}
