/**
 * Bot-engine singleton registry — ONE executing bot engine per account.
 *
 * The trading arbiter (lib/engine-arbiter.ts) locks the EXECUTOR CLASS
 * (autonomous / neuroai / bots) per account session — that is what protects
 * the single recovery ledger across classes. Within the `bots` class there are
 * six engines (the five specialist families + Dual-Lock + Kill-Shot family +
 * Echo Apex + Barrier Bastion), and nothing stopped two of them from running
 * side by side and double-trading the SAME ledger. "One ledger = one engine"
 * means one engine, period: every bot engine registers a cheap running-probe
 * here at module load, and every `startSession` refuses to start while any
 * OTHER probe reports running.
 *
 * Deliberately dependency-free (no imports of the engines): each engine calls
 * `registerBotEngine` with its own closure, so there are no import cycles.
 */

export interface EngineProbe {
  running: boolean;
  name: string;
}

const probes = new Map<string, () => EngineProbe>();

export function registerBotEngine(key: string, probe: () => EngineProbe): void {
  probes.set(key, probe);
}

/** Engines (other than `exceptKey`) currently executing a session. */
export function runningOtherEngines(exceptKey: string): Array<{ key: string; name: string }> {
  const out: Array<{ key: string; name: string }> = [];
  for (const [key, probe] of [...probes.entries()]) {
    if (key === exceptKey) continue;
    let state: EngineProbe;
    try {
      state = probe();
    } catch {
      continue;
    }
    if (state.running) out.push({ key, name: state.name });
  }
  return out;
}
