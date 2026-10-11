import { Loader2, Play, Square, TimerReset } from "lucide-react";

/**
 * Start / stop control for the autonomous engine.
 *
 * It replaces the old dashboard header button plus the always-on "engine status
 * strip" that used to sit under the header: the same information (running state,
 * cooldown countdown, resume action) now lives in ONE compact control that is
 * mounted in the top-right corner of the Quick Strike / autonomous-engine card,
 * so the dashboard has a single place that starts, stops and resumes trading.
 *
 * The three visible states are the three states the engine can actually be in:
 *
 *   ENGINE ON   → running: the button stops it.
 *   ENGINE OFF  → stopped: the button starts it.
 *   RESUME mm:ss→ cooling down after a loss run: the button resumes immediately
 *                 (exactly what the removed strip's "Resume Now" did).
 *
 * `pending` covers an in-flight toggle so a double click can never send two
 * contradictory commands.
 */
export interface EnginePowerState {
  running: boolean;
  /** A toggle request is in flight — the control is disabled until it answers. */
  pending: boolean;
  /** Seconds left in the post-loss cooldown, or null when there is none. */
  cooldownSecs: number | null;
  onToggle: (running: boolean) => void;
}

function formatCooldown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function EnginePowerButton({ running, pending, cooldownSecs, onToggle }: EnginePowerState) {
  const cooldown = cooldownSecs !== null && cooldownSecs > 0;
  const tone = cooldown
    ? { border: "border-amber-500/40", text: "text-amber-300", bg: "bg-amber-500/10", hover: "hover:bg-amber-500/20", dot: "bg-amber-400" }
    : running
      ? { border: "border-rose-500/40", text: "text-rose-300", bg: "bg-rose-500/10", hover: "hover:bg-rose-500/20", dot: "bg-emerald-400" }
      : { border: "border-emerald-500/40", text: "text-emerald-300", bg: "bg-emerald-500/10", hover: "hover:bg-emerald-500/20", dot: "bg-emerald-400" };

  const label = cooldown ? `Resume ${formatCooldown(cooldownSecs)}` : running ? "Engine on" : "Engine off";
  const action = cooldown ? "resume now" : running ? "stop" : "start";
  const title = cooldown
    ? `Engine cooling down — resumes in ${formatCooldown(cooldownSecs)}. Click to resume now.`
    : running
      ? "Autonomous engine is trading — click to stop"
      : "Autonomous engine is stopped — click to start";

  return (
    <button
      type="button"
      onClick={() => onToggle(!running)}
      disabled={pending}
      title={title}
      aria-label={`${label} — ${action} engine`}
      className={`shrink-0 inline-flex items-center gap-1.5 h-7 px-2 rounded-lg border font-mono text-[9px] uppercase tracking-widest whitespace-nowrap transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${tone.border} ${tone.bg} ${tone.text} ${tone.hover}`}
    >
      {pending ? (
        <Loader2 className="w-3 h-3 animate-spin shrink-0" />
      ) : cooldown ? (
        <TimerReset className="w-3 h-3 shrink-0" />
      ) : running ? (
        <span className={`w-1.5 h-1.5 rounded-full animate-pulse shrink-0 ${tone.dot}`} />
      ) : (
        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-zinc-500" />
      )}
      <span className="tabular-nums">{label}</span>
      {!pending && (
        <span className={`inline-flex items-center gap-0.5 pl-1.5 ml-0.5 border-l ${tone.border} font-bold`}>
          {running ? <Square className="w-2.5 h-2.5 fill-current" /> : <Play className="w-2.5 h-2.5 fill-current" />}
          {cooldown ? "NOW" : running ? "STOP" : "START"}
        </span>
      )}
    </button>
  );
}
