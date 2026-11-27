import { Router, type Request, type Response } from "express";
import type { DaemonRunner } from "./messages.js";

export function createModelsRouter(daemon: DaemonRunner): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response) => {
    try {
      const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
      const models = await daemon.getModels(forceRefresh);

      const data = models.map((m) => ({
        id: m.displayName || m.value,
        object: "model",
        created: 1700000000,
        owned_by: `qoder-${m.source || "system"}`,
        qoder: {
          value: m.value,
          modelId: m.modelId,
          displayName: m.displayName,
          maxInputTokens: m.maxInputTokens,
          availableContextWindows: m.availableContextWindows,
          isReasoning: m.isReasoning,
          isFree: m.isFree,
          priceFactor: m.priceFactor,
        },
      }));

      res.json({ object: "list", data });
    } catch (err) {
      res.status(500).json({
        error: { message: (err as Error).message, type: "api_error" },
      });
    }
  });

  return router;
}
