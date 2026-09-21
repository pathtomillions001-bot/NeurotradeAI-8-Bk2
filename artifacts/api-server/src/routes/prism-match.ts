import { Router, type Response } from "express";
import { logger } from "../lib/logger";
import { parsePrismScan, parsePrismStart } from "../lib/prism-match-policy";
import {
  getStatus,
  PrismRequestError,
  scanForPrism,
  startSession,
  stopSession,
} from "../lib/prism-match-engine";

const router = Router();
function fail(res: Response, error: unknown): void {
  if (error instanceof PrismRequestError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  logger.error({ err: error }, "Match Prism request failed");
  res
    .status(500)
    .json({
      error:
        "Prism could not complete this request. No new deployment was authorized; please retry.",
    });
}
router.get("/status", (_req, res) => {
  res.json(getStatus());
});
router.post("/scan", async (req, res): Promise<void> => {
  const parsed = parsePrismScan(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    res.json(await scanForPrism(parsed.value));
  } catch (err) {
    fail(res, err);
  }
});
router.post("/start", async (req, res): Promise<void> => {
  const parsed = parsePrismStart(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    res.json({ ok: true, status: await startSession(parsed.value) });
  } catch (err) {
    fail(res, err);
  }
});
router.post("/stop", (_req, res) => {
  stopSession();
  res.json({ ok: true, status: getStatus() });
});
export default router;
