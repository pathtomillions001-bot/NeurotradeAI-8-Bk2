/**
 * v5 Desk — the decision pipeline strip (Command's 60px context strip).
 *
 * L0 Feed → L1 Regime → L2 Session → L3 Statistics → L4 Gates → L5 Order →
 * L6 Live: the seven layers a trade passes through, each with ONE short value
 * line and a state (ok / warn / block). The current node — the first block,
 * or the gate layer when everything passes — carries the cyan underline, so
 * "why is nothing trading?" is answered by looking at one place.
 *
 * buildPipeline (desk-ui.ts) owns which node says what; this component only
 * draws it. State is colour + glyph + the value's own words, never colour
 * alone.
 */
import type { PipelineNode, PipelineState } from "@/lib/desk-ui";

const STATE_TONE: Record<PipelineState, string> = {
  ok: "d-up",
  warn: "d-am",
  block: "d-dn",
};

const STATE_GLYPH: Record<PipelineState, string> = {
  ok: "",
  warn: "!",
  block: "✕",
};

export function PipelineStrip({ nodes }: { nodes: PipelineNode[] }) {
  return (
    <div className="flex h-full min-w-0 items-stretch gap-1" data-testid="pipeline-strip">
      {nodes.map((node, index) => (
        <div key={node.id} className="flex min-w-0 flex-1 items-stretch gap-1">
          <div
            className={`flex min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-[6px] border border-[var(--desk-line)] bg-[var(--desk-s1)] px-2.5 py-1${node.current ? " desk-node-current" : ""}`}
            data-node={node.id}
            data-state={node.state}
            aria-label={`${node.id} ${node.label}: ${node.value} (${node.state})${node.current ? ", current step" : ""}`}
          >
            <span className="t-cap d-mute flex items-center gap-1 truncate">
              <span className={`desk-dot shrink-0 ${STATE_TONE[node.state]}`} aria-hidden="true" />
              {STATE_GLYPH[node.state] ? <span className={`shrink-0 text-[9px] font-bold leading-none ${STATE_TONE[node.state]}`} aria-hidden="true">{STATE_GLYPH[node.state]}</span> : null}
              <span className="truncate">{node.label}</span>
              {node.current ? <span className="sr-only">(current step)</span> : null}
            </span>
            <span className={`t-title tnum truncate ${node.state === "ok" ? "d-tx" : STATE_TONE[node.state]}`}>{node.value}</span>
          </div>
          {index < nodes.length - 1 ? (
            <span className="d-mute self-center text-[13px] leading-none" aria-hidden="true">
              ›
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
