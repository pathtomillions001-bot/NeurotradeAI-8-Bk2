import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import marketsRouter from "./markets";
import tradesRouter from "./trades";
import analyticsRouter from "./analytics";
import aiRouter from "./ai";
import settingsRouter from "./settings";
import speedAiRouter from "./speed-ai";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/markets", marketsRouter);
router.use("/trades", tradesRouter);
router.use("/analytics", analyticsRouter);
router.use("/ai", aiRouter);
router.use("/settings", settingsRouter);
router.use("/speed-ai", speedAiRouter);

export default router;
