import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import type { QoderDaemonManager } from "../daemon.js";
import {
  splitSystemAndPrompt,
  parseAllToolCallsFromText,
  type OpenAITool,
  type SimpleMessage,
} from "../toolPrompt.js";

export type DaemonRunner = Pick<QoderDaemonManager, "runQuery" | "getModels" | "getState">;

interface AnthropicBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

function flattenAnthropicContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: AnthropicBlock) => {
      if (!block) return "";
      if (typeof block === "string") return block;
      if (block.type === "text") return block.text || "";
      if (block.type === "tool_use") {
        return `[Tool Call: ${block.name}(${JSON.stringify(block.input || {})})]`;
      }
      if (block.type === "tool_result") {
        return `[Tool Result (${block.tool_use_id || "unknown"}): ${flattenAnthropicContent(block.content)}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toOpenAIMessages(system: unknown, messages: Array<{ role?: string; content?: unknown }>): SimpleMessage[] {
  const out: SimpleMessage[] = [];
  if (system) {
    const sysText = flattenAnthropicContent(system);
    if (sysText) out.push({ role: "system", content: sysText });
  }
  for (const msg of messages) {
    out.push({
      role: msg.role || "user",
      content: flattenAnthropicContent(msg.content),
    });
  }
  return out;
}

function toOpenAITools(tools?: AnthropicTool[]): OpenAITool[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

function sendEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function createMessagesRouter(daemon: DaemonRunner): Router {
  const router = Router();

  router.post("/count_tokens", (req: Request, res: Response) => {
    const { system, messages } = req.body || {};
    const openAIMsgs = toOpenAIMessages(system, Array.isArray(messages) ? messages : []);
    const chars = openAIMsgs.reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : 0), 0);
    res.json({ input_tokens: Math.max(1, Math.ceil(chars / 4)) });
  });

  router.post("/", async (req: Request, res: Response) => {
    const {
      messages,
      system,
      model: requestedModel,
      stream = false,
      max_tokens,
      tools,
    } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "messages is required and must be a non-empty array",
        },
      });
      return;
    }

    const openAIMessages = toOpenAIMessages(system, messages);
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const { systemPrompt, prompt } = splitSystemAndPrompt(
      openAIMessages,
      hasTools ? toOpenAITools(tools) : [],
    );

    const msgId = newId("msg");
    const inputTokens = Math.max(1, Math.ceil(prompt.length / 4));
    const abortController = new AbortController();
    req.on("aborted", () => abortController.abort());

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      sendEvent(res, "message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model: requestedModel || "auto",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      });

      if (!hasTools) {
        sendEvent(res, "content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
      }

      const pingTimer = setInterval(() => {
        if (!res.writableEnded) res.write(": ping\n\n");
      }, 15_000);

      try {
        const result = await daemon.runQuery({
          prompt,
          systemPrompt,
          model: requestedModel,
          maxTokens: max_tokens,
          signal: abortController.signal,
          onTextDelta: !hasTools
            ? (delta) => {
                if (!res.writableEnded) {
                  sendEvent(res, "content_block_delta", {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: delta },
                  });
                }
              }
            : undefined,
        });

        clearInterval(pingTimer);
        if (res.writableEnded) return;

        let stopReason = "end_turn";
        if (hasTools) {
          const toolCalls = parseAllToolCallsFromText(result.text);
          if (toolCalls.length === 0 && result.text.includes("tool_call")) {
            console.error("[messages] Failed to parse tool_call:", result.text.slice(0, 400), "...", result.text.slice(-200));
          }
          if (toolCalls.length > 0) {
            toolCalls.forEach((tc, idx) => {
              sendEvent(res, "content_block_start", {
                type: "content_block_start",
                index: idx,
                content_block: {
                  type: "tool_use",
                  id: newId("toolu"),
                  name: tc.name,
                  input: {},
                },
              });
              sendEvent(res, "content_block_delta", {
                type: "content_block_delta",
                index: idx,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(tc.arguments || {}),
                },
              });
              sendEvent(res, "content_block_stop", { type: "content_block_stop", index: idx });
            });
            stopReason = "tool_use";
          } else {
            sendEvent(res, "content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            });
            if (result.text) {
              sendEvent(res, "content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: result.text },
              });
            }
            sendEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
          }
        } else {
          sendEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        }

        const outputTokens = Math.max(1, Math.ceil(result.text.length / 4));
        sendEvent(res, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        sendEvent(res, "message_stop", { type: "message_stop" });
        res.end();
      } catch (err) {
        clearInterval(pingTimer);
        if (!res.writableEnded) {
          sendEvent(res, "error", {
            type: "error",
            error: { type: "api_error", message: (err as Error).message },
          });
          res.end();
        }
      }
      return;
    }

    try {
      const result = await daemon.runQuery({
        prompt,
        systemPrompt,
        model: requestedModel,
        maxTokens: max_tokens,
        signal: abortController.signal,
      });

      let contentBlocks: Array<Record<string, unknown>> = [{ type: "text", text: result.text }];
      let stopReason = "end_turn";

      if (hasTools) {
        const toolCalls = parseAllToolCallsFromText(result.text);
        if (toolCalls.length > 0) {
          contentBlocks = toolCalls.map((tc) => ({
            type: "tool_use",
            id: newId("toolu"),
            name: tc.name,
            input: tc.arguments || {},
          }));
          stopReason = "tool_use";
        }
      }

      const outputTokens = Math.max(1, Math.ceil(result.text.length / 4));
      res.json({
        id: msgId,
        type: "message",
        role: "assistant",
        content: contentBlocks,
        model: requestedModel || result.resolvedModel,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
    } catch (err) {
      res.status(500).json({
        type: "error",
        error: { type: "api_error", message: (err as Error).message },
      });
    }
  });

  return router;
}
