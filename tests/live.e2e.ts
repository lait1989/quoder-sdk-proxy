import assert from "node:assert/strict";
import { QoderDaemonManager } from "../src/daemon.js";
import { createApp } from "../src/app.js";

async function main() {
  if (!process.env.QODER_PERSONAL_ACCESS_TOKEN) {
    console.error("Set QODER_PERSONAL_ACCESS_TOKEN to run live E2E tests.");
    process.exit(1);
  }

  const daemon = new QoderDaemonManager();
  await daemon.ensureDaemon();
  const app = createApp(daemon);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("Failed to bind server");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Live models check
    const modelsRes = await fetch(`${baseUrl}/v1/models?refresh=1`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string }> };
    console.log("Live models:", modelsJson.data.map((m) => m.id));
    assert.ok(modelsJson.data.length > 0, "Expected at least 1 live model");

    // 2. Live Anthropic /v1/messages
    const t0 = Date.now();
    const msgRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "Qwen4-Max",
        max_tokens: 64,
        messages: [{ role: "user", content: "Reply with just: OK" }],
      }),
    });
    assert.equal(msgRes.status, 200);
    const msgJson = (await msgRes.json()) as { content: Array<{ text: string }> };
    console.log(`Live /v1/messages Qwen4-Max (${Date.now() - t0}ms):`, msgJson.content[0].text);
    assert.ok(msgJson.content[0].text.toUpperCase().includes("OK"));

    // 3. Live Anthropic /v1/messages with tool_use
    const t1 = Date.now();
    const toolRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "Qwen3.8-Max",
        max_tokens: 256,
        tools: [
          {
            name: "Bash",
            description: "Run bash command",
            input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          },
        ],
        messages: [{ role: "user", content: "List files in current directory using Bash tool with ls" }],
      }),
    });
    assert.equal(toolRes.status, 200);
    const toolJson = (await toolRes.json()) as { stop_reason: string; content: Array<{ type: string; name: string }> };
    console.log(`Live /v1/messages tool_use (${Date.now() - t1}ms):`, JSON.stringify(toolJson));
    assert.equal(toolJson.stop_reason, "tool_use");
    assert.equal(toolJson.content[0].name, "Bash");

    console.log("ALL LIVE E2E TESTS PASSED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await daemon.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
