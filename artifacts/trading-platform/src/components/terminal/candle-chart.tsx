/**
 * Desk chart — candlesticks rendered from the SAME series the agent analyses.
 *
 * A TradingView widget is available alongside this (see tradingview-panel),
 * but the default chart is drawn from our own feed on purpose: the prices the
 * agent reasons about, the prices the plan is built from and the prices the
 * user sees must be one dataset. A chart fed from a different source would
 * disagree with the signal by a spread and a session, and the user would have
 * no way to tell which was right.
 *
 * Pure SVG — no charting dependency, no network, works offline.
 */

import { useMemo } from "react";
import type { Bar } from "@/lib/desk";

interface Level {
  price: number;
  label: string;
  color: string;
  dashed?: boolean;
}

interface CandleChartProps {
  bars: Bar[];
  digits: number;
  levels?: Level[];
  height?: number;
  /** Most recent N bars to display. */
  visible?: number;
}

const PADDING = { top: 10, right: 62, bottom: 18, left: 6 };

export function CandleChart({ bars, digits, levels = [], height = 320, visible = 110 }: CandleChartProps) {
  const shown = useMemo(() => bars.slice(-visible), [bars, visible]);

  const geometry = useMemo(() => {
    if (shown.length === 0) return null;

    let low = Infinity;
    let high = -Infinity;
    for (const bar of shown) {
      if (bar[3] < low) low = bar[3];
      if (bar[2] > high) high = bar[2];
    }
    // Plan levels must be visible even when they sit outside the price range,
    // otherwise a stop below the window simply vanishes from the chart.
    for (const level of levels) {
      if (Number.isFinite(level.price)) {
        low = Math.min(low, level.price);
        high = Math.max(high, level.price);
      }
    }
    if (!Number.isFinite(low) || !Number.isFinite(high) || high === low) {
      const mid = Number.isFinite(low) ? low : 1;
      low = mid * 0.999;
      high = mid * 1.001;
    }

    const span = high - low;
    const pad = span * 0.08;
    return { low: low - pad, high: high + pad };
  }, [shown, levels]);

  if (!geometry || shown.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-zinc-500 border border-zinc-800 rounded-md"
        style={{ height }}
      >
        No candle data for this symbol yet.
      </div>
    );
  }

  const width = 1000;
  const plotWidth = width - PADDING.left - PADDING.right;
  const plotHeight = height - PADDING.top - PADDING.bottom;
  const slot = plotWidth / shown.length;
  const bodyWidth = Math.max(1.2, slot * 0.62);

  const y = (price: number) =>
    PADDING.top + ((geometry.high - price) / (geometry.high - geometry.low)) * plotHeight;

  const gridlines = Array.from({ length: 5 }, (_, i) => {
    const price = geometry.low + ((geometry.high - geometry.low) * i) / 4;
    return { price, y: y(price) };
  });

  const last = shown[shown.length - 1];
  const lastClose = last[4];
  const lastRising = last[4] >= last[1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ height }}
      preserveAspectRatio="none"
      role="img"
      aria-label="Price chart"
    >
      {gridlines.map((line) => (
        <g key={line.price}>
          <line
            x1={PADDING.left}
            x2={width - PADDING.right}
            y1={line.y}
            y2={line.y}
            stroke="currentColor"
            className="text-zinc-800"
            strokeWidth={1}
          />
          <text
            x={width - PADDING.right + 6}
            y={line.y + 3.5}
            className="fill-zinc-500"
            style={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}
          >
            {line.price.toFixed(digits)}
          </text>
        </g>
      ))}

      {shown.map((bar, i) => {
        const [, open, barHigh, barLow, close] = bar;
        const x = PADDING.left + i * slot + slot / 2;
        const rising = close >= open;
        const colour = rising ? "#10b981" : "#ef4444";
        const top = y(Math.max(open, close));
        const bottom = y(Math.min(open, close));
        return (
          <g key={bar[0]}>
            <line x1={x} x2={x} y1={y(barHigh)} y2={y(barLow)} stroke={colour} strokeWidth={1} />
            <rect
              x={x - bodyWidth / 2}
              y={top}
              width={bodyWidth}
              height={Math.max(1, bottom - top)}
              fill={colour}
            />
          </g>
        );
      })}

      {levels
        .filter((level) => Number.isFinite(level.price))
        .map((level) => (
          <g key={`${level.label}-${level.price}`}>
            <line
              x1={PADDING.left}
              x2={width - PADDING.right}
              y1={y(level.price)}
              y2={y(level.price)}
              stroke={level.color}
              strokeWidth={1.2}
              strokeDasharray={level.dashed === false ? undefined : "5 4"}
              opacity={0.9}
            />
            <text
              x={PADDING.left + 4}
              y={y(level.price) - 4}
              style={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}
              fill={level.color}
            >
              {level.label} {level.price.toFixed(digits)}
            </text>
          </g>
        ))}

      {/* Last price tag */}
      <line
        x1={PADDING.left}
        x2={width - PADDING.right}
        y1={y(lastClose)}
        y2={y(lastClose)}
        stroke={lastRising ? "#10b981" : "#ef4444"}
        strokeWidth={0.8}
        opacity={0.45}
      />
      <rect
        x={width - PADDING.right + 2}
        y={y(lastClose) - 8}
        width={PADDING.right - 4}
        height={16}
        rx={2}
        fill={lastRising ? "#10b981" : "#ef4444"}
      />
      <text
        x={width - PADDING.right + 6}
        y={y(lastClose) + 3.5}
        style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", fontWeight: 600 }}
        fill="#06121f"
      >
        {lastClose.toFixed(digits)}
      </text>
    </svg>
  );
}
