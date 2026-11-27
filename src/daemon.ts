import {
  startDaemon,
  accessTokenFromEnv,
  query,
  type Daemon,
  type ModelInfo,
} from "@qoder-ai/qoder-agent-sdk";
import { config } from "./config.js";

export interface ModelResolver {
  resolve(requested?: string): string;
  list(models: ModelInfo[]): ModelInfo[];
}

export function resolveModelFromList(models: ModelInfo[], requested?: string): string {
  if (!requested) return "auto";
  const trimmed = requested.trim();
  if (!trimmed) return "auto";

  // 1. Exact value/modelId match
  const byValue = models.find((m) => m.value === trimmed || m.modelId === trimmed);
  if (byValue) return byValue.value;

  // 2. Exact displayName match (case-insensitive, e.g. "Qwen4-Max" -> "qmodel_latest")
  const lower = trimmed.toLowerCase();
  const byDisplay = models.find(
    (m) =>
      m.displayName?.toLowerCase() === lower ||
      m.value.toLowerCase() === lower ||
      m.modelId?.toLowerCase() === lower,
  );
  if (byDisplay) return byDisplay.value;

  // 3. Family heuristics mapped to live models when available
  const findByDisplayPrefix = (prefix: string): string | undefined =>
    models.find((m) => m.displayName?.toLowerCase().includes(prefix))?.value;

  if (lower.includes("claude")) {
    if (lower.includes("opus")) return findByDisplayPrefix("ultimate") || "ultimate";
    if (lower.includes("haiku")) return findByDisplayPrefix("fast") || "fast";
    return "auto";
  }
  if (lower.includes("gpt-4") || lower.includes("gpt4") || lower.includes("gpt-3")) {
    return lower.includes("mini") ? "fast" : "auto";
  }
  if (/^o\d/.test(lower)) {
    return lower.includes("mini") ? "efficient" : "ultimate";
  }
  if (lower.includes("gemini")) {
    return lower.includes("flash") || lower.includes("nano") ? "fast" : "efficient";
  }
  if (lower.includes("qwen")) {
    if (lower.includes("3.8") && lower.includes("flash")) {
      return findByDisplayPrefix("qwen3.8-flash") || "qfmodel";
    }
    if (lower.includes("3.8")) {
      return findByDisplayPrefix("qwen3.8") || "qmodel_38max";
    }
    return findByDisplayPrefix("qwen4") || findByDisplayPrefix("qwen") || "qmodel_latest";
  }
  if (lower.includes("deepseek")) {
    return lower.includes("flash")
      ? findByDisplayPrefix("deepseek-flash") || "dfmodel"
      : findByDisplayPrefix("deepseek") || "dmodel";
  }
  if (lower.includes("kimi") || lower.includes("moonshot")) {
    return lower.includes("2.8")
      ? findByDisplayPrefix("2.8") || "kmodel"
      : findByDisplayPrefix("kimi") || "kmodel_latest";
  }
  if (lower.includes("glm")) {
    if (lower.includes("5.3") && lower.includes("flash")) {
      return findByDisplayPrefix("5.3-flash") || "gfmodel";
    }
    if (lower.includes("5.3")) return findByDisplayPrefix("5.3") || "gmodel";
    return findByDisplayPrefix("glm") || "gmodel_latest";
  }
  if (lower.includes("minimax")) {
    return findByDisplayPrefix("minimax") || "mmodel";
  }
  if (lower === "performance" || lower === "lite") {
    return "fast";
  }

  return "auto";
}

export function resolveContextWindow(
  models: ModelInfo[],
  resolvedModel: string,
  targetWindow: number,
): number | undefined {
  if (!targetWindow || targetWindow <= 0) return undefined;
  const info = models.find((m) => m.value === resolvedModel || m.modelId === resolvedModel);
  const windows = info?.availableContextWindows;
  if (!Array.isArray(windows) || windows.length === 0) return undefined;
  const eligible = windows.filter((w) => w <= targetWindow).sort((a, b) => b - a);
  return eligible[0];
}

export interface RunQueryParams {
  prompt: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}

export interface RunQueryResult {
  text: string;
  resolvedModel: string;
  durationMs: number;
  durationApiMs: number;
}

export class QoderDaemonManager {
  private daemon: Daemon | null = null;
  private startPromise: Promise<Daemon> | null = null;
  private cachedModels: ModelInfo[] = [];
  private modelsFetchedAt = 0;

  async ensureDaemon(): Promise<Daemon> {
    if (this.daemon && this.daemon.state === "ready") {
      return this.daemon;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      const t0 = Date.now();
      const d = await startDaemon({
        auth: accessTokenFromEnv(),
        initializeTimeoutMs: 30_000,
      });
      await d.auth();
      d.onFailure((err) => {
        console.error("[daemon] failure:", err.message);
        this.daemon = null;
      });
      this.daemon = d;
      this.startPromise = null;
      console.log(`[daemon] ready in ${Date.now() - t0}ms`);
      // Preload models in background
      this.getModels(true).catch((e) =>
        console.warn("[daemon] initial getModels failed:", (e as Error).message),
      );
      return d;
    })();

    try {
      return await this.startPromise;
    } catch (err) {
      this.startPromise = null;
      throw err;
    }
  }

  async getModels(forceRefresh = false): Promise<ModelInfo[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cachedModels.length > 0 &&
      now - this.modelsFetchedAt < config.modelRefreshTtlMs
    ) {
      return this.cachedModels;
    }

    const d = await this.ensureDaemon();
    const models = await d.getModels();
    if (models.length > 0) {
      this.cachedModels = models;
      this.modelsFetchedAt = Date.now();
    }
    return this.cachedModels;
  }

  async resolveModel(requested?: string): Promise<string> {
    const models = await this.getModels();
    return resolveModelFromList(models, requested);
  }

  async recycleDaemon(): Promise<void> {
    const old = this.daemon;
    this.daemon = null;
    this.startPromise = null;
    if (old) {
      try {
        await Promise.race([
          old.stop(),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      } catch {
        // ignore stop errors on wedged daemon
      }
    }
  }

  async runQuery(params: RunQueryParams): Promise<RunQueryResult> {
    const d = await this.ensureDaemon();
    const models = await this.getModels();
    const resolvedModel = resolveModelFromList(models, params.model);
    const chosenWindow = resolveContextWindow(models, resolvedModel, config.contextWindow);
    const abortController = new AbortController();

    if (params.signal) {
      if (params.signal.aborted) abortController.abort();
      else params.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, config.timeoutMs);
    const startedAt = Date.now();

    let streamedText = "";
    let finalResultText = "";
    let durationApiMs = 0;

    try {
      const q = query({
        prompt: params.prompt,
        options: {
          daemon: d,
          model: resolvedModel,
          tools: [],
          disallowedTools: ["mcp_call", "mcp_get", "mcp_list"],
          systemPrompt:
            params.systemPrompt ||
            "You are a helpful AI assistant. Follow the prompt instructions and function calling JSON format strictly.",
          persistSession: false,
          includePartialMessages: Boolean(params.onTextDelta),
          ...(chosenWindow ? { extraArgs: { "context-window": String(chosenWindow) } } : {}),
          abortController,
        },
      });

      for await (const msg of q) {
        if (msg.type !== "stream_event") {
          const sub = "subtype" in msg ? String(msg.subtype) : "";
          console.log(`[sdk] type=${msg.type}${sub ? " subtype=" + sub : ""}`);
        }
        if (msg.type === "stream_event" && params.onTextDelta) {
          const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            streamedText += ev.delta.text;
            params.onTextDelta(ev.delta.text);
          }
        } else if (msg.type === "assistant") {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && block.type === "text" && typeof block.text === "string" && !streamedText) {
                finalResultText += block.text;
              }
            }
          }
        } else if (msg.type === "result") {
          durationApiMs = msg.duration_api_ms || 0;
          if (msg.subtype === "success" && typeof msg.result === "string" && !streamedText && !finalResultText) {
            finalResultText = msg.result;
          } else if (msg.subtype !== "success" && "errors" in msg && Array.isArray(msg.errors) && msg.errors.length > 0) {
            throw new Error(msg.errors.join("; "));
          }
        }
      }

      if (timedOut) {
        console.warn(`[daemon] Query timed out after ${config.timeoutMs}ms — recycling daemon`);
        await this.recycleDaemon();
        throw new Error(`Qoder SDK query timed out after ${config.timeoutMs}ms`);
      }

      return {
        text: streamedText || finalResultText,
        resolvedModel,
        durationMs: Date.now() - startedAt,
        durationApiMs,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  getState(): string {
    return this.daemon?.state ?? "stopped";
  }

  async stop(): Promise<void> {
    if (this.daemon) {
      await this.daemon.stop();
      this.daemon = null;
    }
  }
}
