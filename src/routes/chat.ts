import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import type { DaemonRunner } from "./messages.js";
import {
  splitSystemAndPrompt,
  parseAllToolCallsFromText,
  type OpenAITool,
  type SimpleMessage,
} from "../toolPrompt.js";

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`;
}

export function createChatRouter(daemon: DaemonRunner): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const { messages, model: requestedModel, stream = false, max_tokens, tools } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
        },
      });
      return;
    }

    const hasTools = Array.isArray(tools) && tools.length > 0;
    const { systemPrompt, prompt } = splitSystemAndPrompt(
      messages as SimpleMessage[],
      hasTools ? (tools as OpenAITool[]) : [],
    );

    const id = newId("chatcmpl");
    const created = Math.floor(Date.now() / 1000);
    const abortController = new AbortController();
    req.on("aborted", () => abortController.abort());

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const firstChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model: requestedModel || "auto",
        choices: [
          {
            index: 0,
            delta: hasTools ? { role: "assistant" } : { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);

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
                  res.write(
                    `data: ${JSON.stringify({
                      id,
                      object: "chat.completion.chunk",
                      created,
                      model: requestedModel || "auto",
                      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                    })}\n\n`,
                  );
                }
              }
            : undefined,
        });

        if (res.writableEnded) return;

        let finishReason = "stop";
        if (hasTools) {
          const toolCalls = parseAllToolCallsFromText(result.text);
          if (toolCalls.length > 0) {
            const openAIToolCalls = toolCalls.map((tc, index) => ({
              index,
              id: newId("call").replace("call-", "call_"),
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments || {}),
              },
            }));
            res.write(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: requestedModel || result.resolvedModel,
                choices: [{ index: 0, delta: { tool_calls: openAIToolCalls }, finish_reason: null }],
              })}\n\n`,
            );
            finishReason = "tool_calls";
          } else if (result.text) {
            res.write(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: requestedModel || result.resolvedModel,
                choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }],
              })}\n\n`,
            );
          }
        }

        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: requestedModel || result.resolvedModel,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (err) {
        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              error: { message: (err as Error).message, type: "api_error" },
            })}\n\n`,
          );
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

      if (hasTools) {
        const toolCalls = parseAllToolCallsFromText(result.text);
        if (toolCalls.length > 0) {
          res.json({
            id,
            object: "chat.completion",
            created,
            model: requestedModel || result.resolvedModel,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: toolCalls.map((tc) => ({
                    id: newId("call").replace("call-", "call_"),
                    type: "function",
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments || {}),
                    },
                  })),
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
          });
          return;
        }
      }

      res.json({
        id,
        object: "chat.completion",
        created,
        model: requestedModel || result.resolvedModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.text },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
      });
    } catch (err) {
      res.status(500).json({
        error: { message: (err as Error).message, type: "api_error" },
      });
    }
  });

  return router;
}
