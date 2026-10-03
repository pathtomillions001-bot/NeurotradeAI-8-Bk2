import { tickManager, tickSecondsFor } from "./deriv";
/** Paper orders settle on future feed ticks, not a random draw from our model. */
export function waitForPaperExpiry(
  symbol: string,
  contractType: string,
  barrier: number | null,
  duration: number,
): Promise<{ won: boolean; entry: number; exit: number }> {
  const start = tickManager.getDigitSnapshot(symbol, 1);
  if (!start) return Promise.reject(new Error("No paper entry tick available"));
  return new Promise((resolve, reject) => {
    let count = 0,
      sequence = start.tick.sequence;
    const cleanup = () => {
      clearTimeout(timer);
      tickManager.off("tick", listener);
    };
    const listener = (event: { symbol: string }) => {
      if (event.symbol !== symbol) return;
      const snapshot = tickManager.getDigitSnapshot(symbol, 1);
      if (!snapshot) return;
      const tick = snapshot.tick;
      if (
        tick.generation !== start.tick.generation ||
        tick.source !== start.tick.source ||
        tick.sequence > sequence + 1
      ) {
        cleanup();
        reject(new Error("Paper feed changed or skipped ticks"));
        return;
      }
      if (tick.sequence <= sequence) return;
      sequence = tick.sequence;
      if (++count < duration) return;
      const won =
        contractType === "CALL"
          ? tick.price > start.tick.price
          : contractType === "PUT"
            ? tick.price < start.tick.price
            : contractType === "DIGITOVER"
              ? tick.digit > barrier!
              : contractType === "DIGITUNDER"
                ? tick.digit < barrier!
                : contractType === "DIGITEVEN"
                  ? tick.digit % 2 === 0
                  : contractType === "DIGITODD"
                    ? tick.digit % 2 !== 0
                    : contractType === "DIGITMATCH"
                      ? tick.digit === barrier
                      : contractType === "DIGITDIFF"
                        ? tick.digit !== barrier
                        : false;
      cleanup();
      resolve({ won, entry: start.tick.price, exit: tick.price });
    };
    const timer = setTimeout(
      () => {
        cleanup();
        reject(new Error("Paper expiry timed out; no outcome recorded"));
      },
      duration * tickSecondsFor(symbol) * 3000 + 15_000,
    );
    tickManager.on("tick", listener);
  });
}
