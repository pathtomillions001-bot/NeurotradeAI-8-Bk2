"""One-shot mechanical move: ai.ts singleton engine -> per-account factory.

Moves (byte-identical, original indentation kept):
  A: engine state lets + GROUP_NAMES + groupCursors      (lines 174-238)
  B: broadcastEngineSSE                                  (lines 407-410)
  C: stopEngine                                           (lines 413-464)
  D: runAutonomousLoop                                   (lines 486-1690)
  E: scheduleNext                                        (lines 1692-1703)
  F: getComputedAgentScores                              (lines 1759-1790)
into function createAutonomousEngine(ownerSessionId), inserted where block A
was, followed by the instance registry. Asserts every boundary; refuses to
write on any mismatch.
"""
import sys

PATH = "artifacts/api-server/src/routes/ai.ts"

with open(PATH) as f:
    lines = f.readlines()

def rng(a, b):
    """1-based inclusive line range -> text."""
    return "".join(lines[a - 1:b])

def check(cond, msg):
    if not cond:
        print(f"ASSERT FAILED: {msg}")
        sys.exit(1)

# ── Boundary assertions (pristine file) ──────────────────────────────────────
check(lines[173].startswith("// ── Engine state"), "A start")
check(lines[237].strip() == "const groupCursors = [0, 0, 0, 0];", "A end")
check(lines[239].startswith("// 13-agent system names"), "after A")
check(lines[406].startswith("function broadcastEngineSSE"), "B start")
check(lines[409].strip() == "}", "B end")
check(lines[411].startswith("// ── Helpers"), "after B")
check(lines[412].startswith("function stopEngine"), "C start")
check(lines[463].strip() == "}", "C end")
check(lines[465].startswith("async function syncLiveBalance"), "after C")
check(lines[485].startswith("async function runAutonomousLoop"), "D start")
check(lines[1689].strip() == "}", "D end")
check(lines[1691].startswith("function scheduleNext"), "E start")
check(lines[1701].strip() == "}", "E end")
check(lines[1703].startswith("// ── Helper: build recommendation payload"), "after E")
check(lines[1758].startswith("async function getComputedAgentScores"), "F start")
check(lines[1788].strip() == "}", "F end")
check(lines[1791].startswith("// ── Routes"), "after F")

blockA = rng(174, 238)
blockB = rng(407, 410)
blockC = rng(413, 464)
blockD = rng(486, 1690)
blockE = rng(1692, 1702)
blockF = rng(1759, 1789)

# ── Block A: drop the singleton owner field (the instance IS the owner) ──────
OWNER_DECL = (
    "// The singleton autonomous executor is pinned to the browser session that\n"
    "// started it. Other visitors cannot inspect, stop, or redirect its credentials.\n"
    "let engineOwnerSessionId: string | null = null;\n"
)
check(OWNER_DECL in blockA, "owner decl in A")
blockA = blockA.replace(
    OWNER_DECL,
    "// (No owner field: this factory instance IS the owner's engine — one\n"
    "// instance per connected Deriv account, held in `autonomousEngines`.)\n",
)

SHELL_TOP = """// ── Per-account autonomous engines ────────────────────────────────────────────
// One fully independent engine instance per connected Deriv account (browser
// session). Previously every variable below was a process-global singleton,
// so starting autonomous trading on account A disabled it (HTTP 409 plus a
// "stopped" status) on account B. Now each account owns its loop, timers,
// cooldowns, loss counters, per-symbol cooldowns and scan state; instances
// share nothing except public market data (tickManager) and the per-session
// recovery ledger (recovery-engine, already session-scoped).
//
// MECHANICAL MOVE — the state declarations and engine functions inside
// createAutonomousEngine() are byte-identical to the old module singletons;
// only the lifecycle wiring around them changed. The engine's scan,
// tournament, recovery and execution logic is UNTOUCHED — verify with:
//   git diff -w -- artifacts/api-server/src/routes/ai.ts
// must show no change inside runAutonomousLoop's trading logic.

/** Public lifecycle surface of one account's autonomous engine instance. */
interface AutonomousEngine {
  readonly ownerSessionId: string;
  isRunning(): boolean;
  /** Start (or restart) the loop. Safe to call when already running. */
  start(opts: { loopIntervalSec: number }): void;
  /** Resume after a server restart. */
  resume(opts: { loopIntervalSec: number }): void;
  /** Manual stop (same semantics as the old toggle-off branch). */
  stop(): void;
  /** Midnight reset of the in-memory daily counters. */
  resetDailyCounters(): void;
  /** Restart market scanning from the first market of each group. */
  resetScanCursors(): void;
  getComputedAgentScores(): Promise<Record<string, number>>;
  snapshot(): {
    running: boolean;
    mode: string;
    tradesExecutedToday: number;
    currentMarket: string | null;
    nextScanIn: number | null;
    stopReasons: string[];
    loopIntervalSec: number;
    lastTradeTime: string | null;
    cooldownUntil: string | null;
    sessionLossCount: number;
  };
}

function createAutonomousEngine(ownerSessionId: string): AutonomousEngine {
"""

SHELL_BOTTOM = """  const startLoop = (initialDelayMs: number): void => {
    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
    autonomousTimer = setTimeout(() => runWithSessionId(ownerSessionId, runAutonomousLoop), initialDelayMs);
  };

  return {
    ownerSessionId,
    isRunning: () => engineRunning,
    start: ({ loopIntervalSec: interval }) => {
      loopIntervalSec = interval;
      // Clear any active cooldown timer when manually starting. Note: the
      // loss-streak counter (recoveryEngine.getState().streakLossCount) is NOT
      // reset here — it is the single source of truth for the cooldown gate
      // and must keep reflecting reality (e.g. restarting mid-streak should
      // not silently clear it).
      if (cooldownResumeTimer) { clearTimeout(cooldownResumeTimer); cooldownResumeTimer = null; }
      cooldownUntil = null;
      sessionLossCount = recoveryEngine.getState().streakLossCount;
      engineRunning = true; autonomousMode = "autonomous"; stopReasons = []; nextScanIn = loopIntervalSec;
      exploitSymbol = null; exploitCount = 0;
      groupCursors.fill(0);
      startLoop(2000);
      logger.info({ loopIntervalSec }, "Autonomous engine started");
    },
    resume: ({ loopIntervalSec: interval }) => {
      loopIntervalSec = interval;
      engineRunning = true;
      autonomousMode = "autonomous";
      stopReasons = [];
      nextScanIn = loopIntervalSec;
      startLoop(2000);
    },
    stop: () => {
      engineRunning = false; autonomousMode = "manual"; currentMarket = null; nextScanIn = null;
      exploitSymbol = null; lastAgentScores = {};
      if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
      if (cooldownResumeTimer) { clearTimeout(cooldownResumeTimer); cooldownResumeTimer = null; }
      cooldownUntil = null;
      releaseTradingOwnership("autonomous");
    },
    resetDailyCounters: () => {
      tradesExecutedToday  = 0;
      sessionLossCount     = 0;
      lastTradeCompletedAt = null;
      recentTradesBySymbol.clear();
      if (cooldownResumeTimer) { clearTimeout(cooldownResumeTimer); cooldownResumeTimer = null; }
      cooldownUntil = null;
    },
    resetScanCursors: () => { groupCursors.fill(0); },
    getComputedAgentScores: () => getComputedAgentScores(),
    snapshot: () => ({
      running: engineRunning,
      mode: autonomousMode,
      tradesExecutedToday,
      currentMarket,
      nextScanIn,
      stopReasons: [...stopReasons],
      loopIntervalSec,
      lastTradeTime: lastTradeTime?.toISOString() ?? null,
      cooldownUntil: cooldownUntil?.toISOString() ?? null,
      sessionLossCount,
    }),
  };
}

const autonomousEngines = new Map<string, AutonomousEngine>();

/** This account's engine instance, created on first use. Never null. */
function getEngine(ownerSessionId: string): AutonomousEngine {
  let engine = autonomousEngines.get(ownerSessionId);
  if (!engine) {
    engine = createAutonomousEngine(ownerSessionId);
    autonomousEngines.set(ownerSessionId, engine);
  }
  return engine;
}

/** Session ids holding an autonomous engine instance (midnight rollover). */
export function autonomousSessionIds(): string[] {
  return [...autonomousEngines.keys()];
}

"""

factory = (
    SHELL_TOP
    + blockA + "\n"
    + blockB + "\n"
    + blockC + "\n"
    + blockD + "\n"
    + blockE + "\n"
    + blockF + "\n"
    + SHELL_BOTTOM
)

# ── Splice bottom-to-top so earlier ranges stay valid ─────────────────────────
# Cut F, E, D, C, B (replace with ""), then replace A with the factory.
out = list(lines)
out[1758:1789] = []        # F (lines 1759-1789)
out[1691:1702] = []        # E (lines 1692-1702)
out[485:1690] = []         # D (lines 486-1690)
out[412:464] = []          # C (lines 413-464)
out[406:410] = []          # B (lines 407-410)
# A sits at original index 173..237; earlier cuts were all AFTER it, so replace in place.
out[173:238] = [factory]

with open(PATH, "w") as f:
    f.writelines(out)

print("splice ok")
