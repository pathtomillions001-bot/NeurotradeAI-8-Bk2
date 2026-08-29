import { Router } from "express";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { broadcastSSE } from "../lib/sse";

const router = Router();

async function getOrCreateSettings() {
  const existing = await db.select().from(settingsTable).limit(1);
  if (existing.length > 0) return existing[0];
  const [created] = await db.insert(settingsTable).values({}).returning();
  return created;
}

function formatSettings(s: typeof settingsTable.$inferSelect) {
  return {
    id: s.id,
    riskProfile: s.riskProfile,
    maxRiskPerTrade: Number(s.maxRiskPerTrade),
    dailyTarget: Number(s.dailyTarget),
    dailyLossLimit: Number(s.dailyLossLimit),
    maxDrawdown: Number(s.maxDrawdown),
    consecutiveLossLimit: s.consecutiveLossLimit,
    minConfidenceThreshold: Number(s.minConfidenceThreshold),
    marketRotationAfter: s.marketRotationAfter,
    preferredContractTypes: s.preferredContractTypes.split(",").filter(Boolean),
    preferredCategories: s.preferredCategories.split(",").filter(Boolean),
    allowedMarkets: s.allowedMarkets ? s.allowedMarkets.split(",").filter(Boolean) : [],
    autonomousEnabled: s.autonomousEnabled,
    loopIntervalSec: s.loopIntervalSec,
    recoveryMode: s.recoveryMode,
    recoveryMultiplier: Number(s.recoveryMultiplier),
    maxRecoverySteps: s.maxRecoverySteps,
    scanAllMarkets: s.scanAllMarkets,
    tradeDurationSec: s.tradeDurationSec,
    maxTradeStake: Number(s.maxTradeStake),
    paperTradeMode: s.paperTradeMode,
    requirePositiveEv: s.requirePositiveEv,
    cooldownMinutes: s.cooldownMinutes,
    normalOverDigit: s.normalOverDigit,
    normalUnderDigit: s.normalUnderDigit,
    recoveryOverDigit: s.recoveryOverDigit,
    recoveryUnderDigit: s.recoveryUnderDigit,
    recoveryMethod: (s as any).recoveryMethod ?? "split",
    recoveryAutoMode: (s as any).recoveryAutoMode ?? true,
    riskAmountType: (s as any).riskAmountType ?? "fixed",
    riskAmountValue: Number((s as any).riskAmountValue ?? 1),
  };
}

router.get("/", async (_req, res): Promise<void> => {
  const settings = await getOrCreateSettings();
  res.json(formatSettings(settings));
});

router.put("/", async (req, res): Promise<void> => {
  logger.info({ body: req.body }, "PUT /api/settings received");
  const parseResult = UpdateSettingsBody.safeParse(req.body);
  if (!parseResult.success) {
    logger.error({ issues: parseResult.error.issues }, "Settings validation failed");
    res.status(400).json({ error: "Invalid settings", details: parseResult.error.issues });
    return;
  }

  try {
    const settings = await getOrCreateSettings();
    const updates = parseResult.data;

  const updateData: Partial<typeof settingsTable.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (updates.riskProfile !== undefined) updateData.riskProfile = updates.riskProfile;
  if (updates.maxRiskPerTrade !== undefined) updateData.maxRiskPerTrade = String(updates.maxRiskPerTrade);
  if (updates.dailyTarget !== undefined) updateData.dailyTarget = String(updates.dailyTarget);
  if (updates.dailyLossLimit !== undefined) updateData.dailyLossLimit = String(updates.dailyLossLimit);
  if (updates.maxDrawdown !== undefined) updateData.maxDrawdown = String(updates.maxDrawdown);
  if (updates.consecutiveLossLimit !== undefined) updateData.consecutiveLossLimit = updates.consecutiveLossLimit;
  if (updates.minConfidenceThreshold !== undefined) updateData.minConfidenceThreshold = String(updates.minConfidenceThreshold);
  if (updates.marketRotationAfter !== undefined) updateData.marketRotationAfter = updates.marketRotationAfter;
  const toCommaStr = (v: string | string[] | undefined): string => Array.isArray(v) ? v.join(",") : (v ?? "");
  if (updates.preferredContractTypes !== undefined) updateData.preferredContractTypes = toCommaStr(updates.preferredContractTypes);
  if (updates.preferredCategories !== undefined) updateData.preferredCategories = toCommaStr(updates.preferredCategories);
  if (updates.autonomousEnabled !== undefined) updateData.autonomousEnabled = updates.autonomousEnabled;
  if ((updates as any).allowedMarkets !== undefined) {
    const am = (updates as any).allowedMarkets;
    updateData.allowedMarkets = Array.isArray(am) ? am.join(",") : (am ?? "");
  }
  if ((updates as any).loopIntervalSec !== undefined) updateData.loopIntervalSec = (updates as any).loopIntervalSec;
  if ((updates as any).recoveryMode !== undefined) updateData.recoveryMode = (updates as any).recoveryMode;
  if ((updates as any).recoveryMultiplier !== undefined) updateData.recoveryMultiplier = String((updates as any).recoveryMultiplier);
  if ((updates as any).maxRecoverySteps !== undefined) updateData.maxRecoverySteps = (updates as any).maxRecoverySteps;
  if ((updates as any).scanAllMarkets !== undefined) updateData.scanAllMarkets = (updates as any).scanAllMarkets;
  if ((updates as any).tradeDurationSec !== undefined) updateData.tradeDurationSec = (updates as any).tradeDurationSec;
  if ((updates as any).maxTradeStake !== undefined) updateData.maxTradeStake = String((updates as any).maxTradeStake);
  if ((updates as any).paperTradeMode !== undefined) updateData.paperTradeMode = (updates as any).paperTradeMode;
  if ((updates as any).requirePositiveEv !== undefined) updateData.requirePositiveEv = (updates as any).requirePositiveEv;
  if ((updates as any).cooldownMinutes !== undefined) updateData.cooldownMinutes = (updates as any).cooldownMinutes;
  if ((updates as any).normalOverDigit !== undefined) updateData.normalOverDigit = (updates as any).normalOverDigit;
  if ((updates as any).normalUnderDigit !== undefined) updateData.normalUnderDigit = (updates as any).normalUnderDigit;
  if ((updates as any).recoveryOverDigit !== undefined) updateData.recoveryOverDigit = (updates as any).recoveryOverDigit;
  if ((updates as any).recoveryUnderDigit !== undefined) updateData.recoveryUnderDigit = (updates as any).recoveryUnderDigit;
  if ((updates as any).recoveryMethod !== undefined) (updateData as any).recoveryMethod = (updates as any).recoveryMethod;
  if ((updates as any).recoveryAutoMode !== undefined) (updateData as any).recoveryAutoMode = (updates as any).recoveryAutoMode;
  if ((updates as any).riskAmountType !== undefined) (updateData as any).riskAmountType = (updates as any).riskAmountType;
  if ((updates as any).riskAmountValue !== undefined) (updateData as any).riskAmountValue = String((updates as any).riskAmountValue);

    const [updated] = await db.update(settingsTable)
      .set(updateData)
      .where(eq(settingsTable.id, settings.id))
      .returning();

    logger.info({ id: updated.id }, "Settings saved successfully");
    // Notify all connected dashboard clients so they immediately refresh
    // market data, engine status, and contract-type displays without a page reload.
    broadcastSSE("settings_updated", {
      preferredContractTypes: updated.preferredContractTypes.split(",").filter(Boolean),
      ts: Date.now(),
    });
    res.json(formatSettings(updated));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: e, msg }, "Settings save DB error");
    res.status(500).json({ error: msg });
  }
});

export default router;
