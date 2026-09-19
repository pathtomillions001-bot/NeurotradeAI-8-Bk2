import { Router } from "express";
import { parsePulseAccountConfig, parsePulseAccountScan } from "../lib/match-pulse-config";
import { getMatchPulseStatus, scanMatchPulse, startMatchPulse, stopMatchPulse, reconcileMatchPulse } from "../lib/match-pulse-engine";
import { hasRiskAcknowledgment, RISK_ACKNOWLEDGMENT_REQUIRED } from "../lib/session";
import { friendlyErrorMessage } from "../lib/friendly-error";

const router = Router();
router.get("/status", (_req, res) => { res.json(getMatchPulseStatus()); });
router.post("/scan", async (req, res): Promise<void> => {
  let spec;
  try { spec = parsePulseAccountScan(req.body); }
  catch (error) { res.status(400).json({ error: friendlyErrorMessage(error) }); return; }
  try { res.json(await scanMatchPulse(spec)); }
  catch (error) { res.status(409).json({ error: friendlyErrorMessage(error) }); }
});
router.post("/start", async (req, res): Promise<void> => {
  let config;
  try { config = parsePulseAccountConfig(req.body); }
  catch (error) { res.status(400).json({ error: friendlyErrorMessage(error) }); return; }
  if (!hasRiskAcknowledgment(req)) {
    res.status(428).json({ error: RISK_ACKNOWLEDGMENT_REQUIRED, code: "RISK_ACK_REQUIRED" });
    return;
  }
  try {
    await startMatchPulse(config);
    res.json({ ok: true, status: getMatchPulseStatus() });
  } catch (error) { res.status(409).json({ error: friendlyErrorMessage(error) }); }
});
router.post("/stop", (_req, res) => {
  stopMatchPulse();
  res.json({ ok: true, status: getMatchPulseStatus() });
});
router.post("/reconcile", async (_req, res): Promise<void> => {
  await reconcileMatchPulse();
  res.json({ ok: true, status: getMatchPulseStatus() });
});
export default router;
