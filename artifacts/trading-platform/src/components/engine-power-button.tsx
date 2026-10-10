import { Play, Square, Clock } from "lucide-react";

// ── Redesigned engine start/stop control ─────────────────────────────────────
// Lives at the TOP RIGHT of the Quick Strike card, on both of its faces: the
// manual "Quick Strike" face (engine off → START, cooldown → RESUME) and the
// autonomous engine face (engine on → STOP). Purely presentational — the toggle
// mutation (and its error surfacing) stays in the Dashboard, which owns the
// `useToggleAutonomousEngine` hook.
//
// The three states use static Tailwind class strings (not inline styles) so the
// classes are visible to the compiler:
//   running   → red    STOP ENGINE
//   cooldown  → amber  RESUME NOW (engine paused by a safety cooldown)
//   off       → green  START ENGINE
export function EnginePowerButton({
  running,
  cooldownSecs,
  pending,
  onToggle,
}: {
  running: boolean;
  /** Seconds until the engine auto-resumes from a safety cooldown (engine-off face only). */
  cooldownSecs?: number | null;
  /** True while the toggle request is in flight — disables and shows an ellipsis. */
  pending?: boolean;
  onToggle: (running: boolean) => void;
}) {
  const inCooldown = !running && cooldownSecs != null && cooldownSecs > 0;

  const state = running ? "stop" : inCooldown ? "resume" : "start";

  const styles: Record<typeof state, string> = {
    stop: "border-red-500/50 text-red-400 bg-red-500/10 hover:bg-red-500/20 hover:border-red-500/70",
    resume:
      "border-amber-500/50 text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 hover:border-amber-500/70",
    start:
      "border-emerald-500/50 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 hover:border-emerald-500/70",
  };

  const label = state === "stop" ? "Stop Engine" : state === "resume" ? "Resume Now" : "Start Engine";
  const title =
    state === "stop"
      ? "Stop the autonomous engine"
      : state === "resume"
        ? `Safety cooldown active — auto-resumes in ${cooldownSecs}s. Click to resume now.`
        : "Start the autonomous trading engine";

  return (
    <button
      onClick={() => onToggle(!running)}
      disabled={pending}
      title={title}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 font-mono text-[9px] font-bold uppercase tracking-widest transition-all active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-50 ${styles[state]}`}
    >
      {pending ? (
        <span className="text-[10px] leading-none">…</span>
      ) : state === "stop" ? (
        <Square className="h-2.5 w-2.5 fill-current" />
      ) : state === "resume" ? (
        <Clock className="h-2.5 w-2.5" />
      ) : (
        <Play className="h-2.5 w-2.5 fill-current" />
      )}
      {/* Label hides on very narrow screens so the card header never wraps or
          overlaps the contract-group tabs — the icon alone still reads clearly. */}
      <span className="max-[430px]:hidden">{label}</span>
    </button>
  );
}
