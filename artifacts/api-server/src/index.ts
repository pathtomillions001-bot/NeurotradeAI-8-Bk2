import app from "./app";
import { logger } from "./lib/logger";
import { startBridgeLinkSweeper } from "./routes/bridge";

const rawPort = process.env["API_PORT"] ?? process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Server listening on 0.0.0.0");
});

/**
 * Release MT5 links whose terminal has stopped heartbeating.
 *
 * A pairing code is active only while the terminal it paired with is running:
 * the EA says so itself through `/api/bridge/disconnect` when MT5 closes it,
 * and this sweeper is the backstop for the cases where no shutdown code ever
 * runs (a power cut, a killed process, a VPS reboot). Without it those links —
 * and the account claims they hold — would survive as ghosts nothing can see.
 */
startBridgeLinkSweeper();
