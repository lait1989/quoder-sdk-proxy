import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { ModelInfo } from "@qoder-ai/qoder-agent-sdk";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import type { DaemonRunner } from "../src/routes/messages.js";

const MOCK_MODELS: ModelInfo[] = [
  { value: "auto", displayName: "Auto", description: "", modelId: "auto" },
  { value: "qmodel_latest", displayName: "Qwen4-Max", description: "", modelId: "qmodel_latest" },
  { value: "qmodel_38max", displayName: "Qwen3.8-Max", description: "", modelId: "qmodel_38max" },
];

describe("HTTP API", () => {
  let server: Server;
  let baseUrl: string;
  const origKey = config.apiKey;

  const mockDaemon: DaemonRunner = {
    getState: () => "ready",
    getModels: async () => MOCK_MODELS,
    runQuery: async (params) => {
      if (params.prompt.includes("Available functions:")) {
        return {
          text: '{"tool_call":{"name":"Bash","arguments":{"command":"ls"}}}',
          resolvedModel: "qmodel_38max",
          durationMs: 120,
          durationApiMs: 100,
        };
      }
      if (params.onTextDelta) {
        params.onTextDelta("O");
        params.onTextDelta("K");
      }
      return {
        text: "OK",
        resolvedModel: "qmodel_latest",
        durationMs: 100,
        durationApiMs: 80,
      };
    },
  };

  before(async () => {
    config.apiKey = "test-secret-key";
    const app = createApp(mockDaemon);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    config.apiKey = origKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /health returns ok and model count", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; modelsCount: number };
    assert.equal(body.status, "ok");
    assert.equal(body.modelsCount, 3);
  });

  it("enforces auth on /v1/models and accepts both Bearer and x-api-key", async () => {
    const unauth = await fetch(`${baseUrl}/v1/models`);
    assert.equal(unauth.status, 401);

    const byBearer = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: "Bearer test-secret-key" },
    });
    assert.equal(byBearer.status, 200);
    const body = (await byBearer.json()) as { data: Array<{ id: string }> };
    assert.ok(body.data.some((m) => m.id === "Qwen4-Max"));

    const byXApi = await fetch(`${baseUrl}/v1/models`, {
      headers: { "x-api-key": "test-secret-key" },
    });
    assert.equal(byXApi.status, 200);
  });

  it("POST /v1/messages returns Anthropic tool_use when tools are present", async () => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-secret-key" },
      body: JSON.stringify({
        model: "Qwen3.8-Max",
        tools: [{ name: "Bash", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "list dir" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { stop_reason: string; content: Array<{ type: string; name: string }> };
    assert.equal(body.stop_reason, "tool_use");
    assert.equal(body.content[0].type, "tool_use");
    assert.equal(body.content[0].name, "Bash");
  });

  it("POST /v1/messages streams SSE events", async () => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-secret-key" },
      body: JSON.stringify({
        model: "Qwen4-Max",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("event: message_start"));
    assert.ok(text.includes('"text":"O"'));
    assert.ok(text.includes("event: message_stop"));
  });

  it("POST /v1/chat/completions returns OpenAI completion", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret-key" },
      body: JSON.stringify({
        model: "Qwen4-Max",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0].message.content, "OK");
  });
});
