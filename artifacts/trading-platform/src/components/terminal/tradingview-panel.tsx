/**
 * TradingView Advanced Chart widget.
 *
 * TradingView publishes no public market-data API; what it does offer, free
 * and within its terms, is the embeddable widget. So the desk uses it for
 * exactly what it is good for — the chart the user wants to look at — while
 * every number the agent computes comes from the execution feed. Scraping
 * their internal socket would violate the terms and break without warning.
 *
 * The widget loads a third-party script, so this component is written to fail
 * gracefully: offline, blocked, or sandboxed without outbound access, it says
 * so and points the user back at the desk chart rather than showing an empty
 * grey box.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

const SCRIPT_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
const LOAD_TIMEOUT_MS = 6000;

/**
 * Map a broker symbol to a TradingView ticker.
 *
 * Broker naming is not standardised (US30 / DJI / WS30 / US30.cash all exist),
 * so this is a best-effort display mapping only — it never feeds a decision.
 */
export function toTradingViewSymbol(symbol: string): string {
  const upper = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const explicit: Record<string, string> = {
    US30: "CAPITALCOM:US30",
    NAS100: "CAPITALCOM:US100",
    US100: "CAPITALCOM:US100",
    SPX500: "CAPITALCOM:US500",
    US500: "CAPITALCOM:US500",
    GER40: "CAPITALCOM:DE40",
    UK100: "CAPITALCOM:UK100",
    XAUUSD: "OANDA:XAUUSD",
    XAGUSD: "OANDA:XAGUSD",
    BTCUSD: "BINANCE:BTCUSDT",
    ETHUSD: "BINANCE:ETHUSDT",
    WTI: "TVC:USOIL",
    USOIL: "TVC:USOIL",
  };
  if (explicit[upper]) return explicit[upper];
  // Six-letter FX pairs map cleanly onto OANDA's naming.
  if (/^[A-Z]{6}$/.test(upper)) return `OANDA:${upper}`;
  return upper;
}

const TIMEFRAME_TO_INTERVAL: Record<string, string> = {
  M1: "1",
  M5: "5",
  M15: "15",
  M30: "30",
  H1: "60",
  H4: "240",
  D1: "D",
};

interface TradingViewPanelProps {
  symbol: string;
  timeframe: string;
  height?: number;
}

export function TradingViewPanel({ symbol, timeframe, height = 320 }: TradingViewPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    setStatus("loading");
    container.innerHTML = "";

    // The widget script replaces the contents of its own parent node, so it
    // needs a dedicated wrapper that we can safely tear down on symbol change.
    const widgetHost = document.createElement("div");
    widgetHost.className = "tradingview-widget-container__widget";
    widgetHost.style.height = `${height}px`;
    container.appendChild(widgetHost);

    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      autosize: false,
      width: "100%",
      height,
      symbol: toTradingViewSymbol(symbol),
      interval: TIMEFRAME_TO_INTERVAL[timeframe] ?? "15",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: false,
      save_image: false,
      backgroundColor: "rgba(9, 12, 20, 1)",
      gridColor: "rgba(63, 63, 70, 0.3)",
      calendar: false,
      support_host: "https://www.tradingview.com",
    });

    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      setStatus("ready");
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      setStatus("unavailable");
    };

    script.addEventListener("load", succeed);
    script.addEventListener("error", fail);
    container.appendChild(script);

    // A blocked request can hang rather than erroring, so time it out too.
    const timer = window.setTimeout(() => {
      if (!widgetHost.querySelector("iframe")) fail();
      else succeed();
    }, LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timer);
      script.removeEventListener("load", succeed);
      script.removeEventListener("error", fail);
      container.innerHTML = "";
    };
  }, [symbol, timeframe, height]);

  return (
    <div className="relative" style={{ height }}>
      <div ref={containerRef} className="tradingview-widget-container h-full w-full" />

      {status !== "ready" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950/80 text-center px-6"
          data-testid="tradingview-status"
        >
          {status === "loading" ? (
            <>
              <div className="w-5 h-5 rounded-full border-2 border-zinc-600 border-t-emerald-400 animate-spin" />
              <p className="text-xs text-zinc-400">Loading TradingView chart…</p>
            </>
          ) : (
            <>
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              <p className="text-xs text-zinc-300 font-medium">TradingView widget could not load</p>
              <p className="text-[11px] text-zinc-500 max-w-sm leading-relaxed">
                This environment has no outbound access to TradingView. Switch to the
                <span className="text-zinc-300"> Desk chart</span> tab — it is drawn from the same
                feed the agent analyses, so it is the authoritative view anyway.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
