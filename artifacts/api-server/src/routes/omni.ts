import { Router } from "express";
import { omniConfigSchema, omniStartSchema } from "../lib/omni-config";
import {
  getStatus,
  scanForOmni,
  startSession,
  stopSession,
} from "../lib/omni-engine";
import { friendlyErrorMessage } from "../lib/friendly-error";

/** All state, scan tokens, SSE and orders resolve through browserSession's ALS. */
const router = Router();
router.get("/status", (_req, res) => {
  res.json(getStatus());
});
router.post("/scan", async (req, res): Promise<void> => {
  const parsed = omniConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({
        error: parsed.error.issues[0]?.message ?? "Invalid scan configuration",
      });
    return;
  }
  try {
    res.json(await scanForOmni(parsed.data));
  } catch (error) {
    res.status(409).json({ error: friendlyErrorMessage(error) });
  }
});
router.post("/start", async (req, res): Promise<void> => {
  const parsed = omniStartSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? "Invalid deployment" });
    return;
  }
  if (
    parsed.data.config.executionMode === "live" &&
    parsed.data.acknowledgeLiveRisk !== true
  ) {
    res
      .status(400)
      .json({
        error:
          "Acknowledge that live trading and recovery can lose money before deploying",
      });
    return;
  }
  try {
    const result = await startSession(parsed.data);
    res.status(result.ok ? 200 : 409).json({ ...result, status: getStatus() });
  } catch (error) {
    res.status(500).json({ error: friendlyErrorMessage(error) });
  }
});
router.post("/stop", (_req, res) => {
  res.json({ ok: true, status: stopSession() });
});
export default router;
