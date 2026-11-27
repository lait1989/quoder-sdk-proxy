import express, { type Express } from "express";
import cors from "cors";
import { config } from "./config.js";
import { authMiddleware } from "./middleware/auth.js";
import { createMessagesRouter, type DaemonRunner } from "./routes/messages.js";
import { createChatRouter } from "./routes/chat.js";
import { createModelsRouter } from "./routes/models.js";

export function createApp(daemon: DaemonRunner): Express {
  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "10mb" }));

  app.get("/", (_req, res) => {
    res.json({
      name: "qoder-sdk-proxy",
      version: "0.1.0",
      daemonState: daemon.getState(),
      endpoints: [
        "GET /health",
        "GET /v1/models",
        "POST /v1/messages",
        "POST /v1/messages/count_tokens",
        "POST /v1/chat/completions",
      ],
    });
  });

  app.get("/health", async (_req, res) => {
    try {
      const models = await daemon.getModels();
      res.json({
        status: daemon.getState() === "ready" ? "ok" : "degraded",
        daemonState: daemon.getState(),
        modelsCount: models.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({
        status: "degraded",
        daemonState: daemon.getState(),
        error: (err as Error).message,
      });
    }
  });

  app.use("/v1", authMiddleware);
  app.use("/v1/models", createModelsRouter(daemon));
  app.use("/v1/messages", createMessagesRouter(daemon));
  app.use("/v1/chat/completions", createChatRouter(daemon));

  return app;
}
