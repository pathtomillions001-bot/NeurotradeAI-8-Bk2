import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import marketsRouter from "./markets";
import tradesRouter from "./trades";
import analyticsRouter from "./analytics";
import aiRouter from "./ai";
import settingsRouter from "./settings";
import speedAiRouter from "./speed-ai";
import botsRouter from "./bots";
import marketIntelligenceRouter from "./market-intelligence";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/markets", marketsRouter);
router.use("/trades", tradesRouter);
router.use("/analytics", analyticsRouter);
router.use("/ai", aiRouter);
router.use("/settings", settingsRouter);
router.use("/speed-ai", speedAiRouter);
router.use("/bots", botsRouter);
// Independent institutional-style, candle-based analysis surface. It does not
// share the legacy options/digit engine, its caches, or its simulation fallback.
router.use("/market-intelligence", marketIntelligenceRouter);

export default router;
