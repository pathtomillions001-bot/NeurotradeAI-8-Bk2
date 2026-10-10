import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAiEngineStatus,
  useToggleAutonomousEngine,
  getGetAiEngineStatusQueryKey,
} from "@workspace/api-client-react";
import { Play, Square } from "lucide-react";
import { toast } from "sonner";

/**
 * Compact start/stop control for the autonomous engine, designed to sit in the
 * top-right corner of the Quick Strike card (and the autonomous engine card's
 * header while running). Replaces the old dashboard header button and the
 * full-width engine status strip, keeping the same states:
 *
 *  - stopped   → green "START ENGINE" pill
 *  - cooldown  → amber "RESUME" pill (safety pause counts down live)
 *  - running   → red "STOP ENGINE" pill
 */
export function EngineToggleButton() {
  const { data: engine } = useGetAiEngineStatus();
  const toggle = useToggleAutonomousEngine();
  const queryClient = useQueryClient();
  const running = !!engine?.isRunning;
  const cooldownUntil = (engine as any)?.cooldownUntil as string | undefined;

  // Live countdown while the engine is in its safety-pause cooldown, so the
  // button can surface "resume in Xs" the way the old status strip did.
  const [cooldownSecs, setCooldownSecs] = useState<number | null>(null);
  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownSecs(null);
      return;
    }
    const target = new Date(cooldownUntil).getTime();
    const update = () => {
      const remaining = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setCooldownSecs(remaining > 0 ? remaining : null);
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [cooldownUntil]);

  const inCooldown = !running && cooldownSecs !== null;

  const handleClick = () => {
    toggle.mutate(
      { data: { running: true } },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({ queryKey: getGetAiEngineStatusQueryKey() }),
        onError: (err: any) =>
          toast.error(err?.data?.error ?? err?.message ?? "Could not toggle the engine"),
      },
    );
  };

  const handleStop = () => {
    toggle.mutate(
      { data: { running: false } },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({ queryKey: getGetAiEngineStatusQueryKey() }),
        onError: (err: any) =>
          toast.error(err?.data?.error ?? err?.message ?? "Could not toggle the engine"),
      },
    );
  };

  if (running) {
    return (
      <button
        onClick={handleStop}
        disabled={toggle.isPending}
        title="Stop the autonomous engine"
        className="flex items-center gap-1.5 h-6 px-2.5 rounded-lg border font-mono text-[8px] font-bold uppercase tracking-widest transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        style={{
          borderColor: "rgba(239,68,68,0.5)",
          background: "rgba(239,68,68,0.12)",
          color: "#f87171",
          boxShadow: "0 0 12px rgba(239,68,68,0.2)",
        }}
      >
        <Square className="w-2 h-2 fill-current shrink-0" />
        {toggle.isPending ? "…" : "Stop Engine"}
      </button>
    );
  }

  if (inCooldown) {
    return (
      <button
        onClick={handleClick}
        disabled={toggle.isPending}
        title="Resume the autonomous engine now"
        className="flex items-center gap-1.5 h-6 px-2.5 rounded-lg border font-mono text-[8px] font-bold uppercase tracking-widest transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        style={{
          borderColor: "rgba(245,158,11,0.5)",
          background: "rgba(245,158,11,0.12)",
          color: "#fbbf24",
          boxShadow: "0 0 12px rgba(245,158,11,0.2)",
        }}
      >
        <Play className="w-2.5 h-2.5 fill-current shrink-0" />
        {toggle.isPending ? "…" : cooldownSecs !== null ? `Resume · ${cooldownSecs}s` : "Resume"}
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={toggle.isPending}
      title="Start the autonomous engine"
      className="flex items-center gap-1.5 h-6 px-2.5 rounded-lg border font-mono text-[8px] font-bold uppercase tracking-widest transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
      style={{
        borderColor: "rgba(16,185,129,0.5)",
        background: "rgba(16,185,129,0.12)",
        color: "#34d399",
        boxShadow: "0 0 12px rgba(16,185,129,0.25)",
      }}
    >
      <Play className="w-2.5 h-2.5 fill-current shrink-0" />
      {toggle.isPending ? "…" : "Start Engine"}
    </button>
  );
}
