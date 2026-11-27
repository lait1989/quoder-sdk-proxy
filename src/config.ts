export interface Config {
  port: number;
  host: string;
  apiKey: string | null;
  corsOrigin: string;
  timeoutMs: number;
  modelRefreshTtlMs: number;
  maxOutputTokens: string;
}

export const config: Config = {
  port: parseInt(process.env.PORT || "3000", 10),
  host: process.env.HOST || "0.0.0.0",
  apiKey: process.env.PROXY_API_KEY || null,
  corsOrigin: process.env.CORS_ORIGIN || "*",
  timeoutMs: parseInt(process.env.QODER_TIMEOUT_MS || "300000", 10),
  modelRefreshTtlMs: parseInt(process.env.MODEL_REFRESH_TTL_MS || "300000", 10),
  maxOutputTokens: process.env.QODER_MAX_OUTPUT_TOKENS || "32k",
};
