import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const xApiKey = req.headers["x-api-key"];

  let token: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (xApiKey) {
    token = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  }

  if (!token) {
    res.status(401).json({
      error: {
        message: "Missing Authorization Bearer token or x-api-key header",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
    return;
  }

  if (token !== config.apiKey) {
    res.status(401).json({
      error: {
        message: "Invalid API key",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
    return;
  }

  next();
}
