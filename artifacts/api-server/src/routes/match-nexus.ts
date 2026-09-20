import { Router, type Response } from "express";
import { logger } from "../lib/logger";
import { parseNexusScan, parseNexusStart } from "../lib/match-nexus-policy";
import {
  getStatus,
  NexusRequestError,
  scanForNexus,
  startSession,
  stopSession,
} from "../lib/match-nexus-engine";

const router = Router();
function fail(res: Response, error: unknown): void {
  if (error instanceof NexusRequestError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  logger.error({ err: error }, "Match Nexus request failed");
  res
    .status(500)
    .json({
      error:
        "Nexus could not complete this request. No new deployment was authorized; please retry.",
    });
}
router.get("/status", (_req, res) => {
  res.json(getStatus());
});
router.post("/scan", async (req, res): Promise<void> => {
  const parsed = parseNexusScan(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    res.json(await scanForNexus(parsed.value));
  } catch (err) {
    fail(res, err);
  }
});
router.post("/start", async (req, res): Promise<void> => {
  const parsed = parseNexusStart(req.body);
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
