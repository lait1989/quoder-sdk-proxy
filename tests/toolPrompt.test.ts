import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllToolCallsFromText, buildPromptWithTools, buildConversationPrompt, splitSystemAndPrompt } from "../src/toolPrompt.js";

describe("toolPrompt", () => {
  it("parses single tool_call with unescaped quotes and multiline command", () => {
    const raw = `{"tool_call":{"name":"Bash","arguments":{"command":"printf 'a\\n'\n'b' && curl -H "Cookie: $(cat /tmp/c.txt)" https://example.com","description":"Fetch"}}}`;
    const res = parseAllToolCallsFromText(raw);
    assert.equal(res.length, 1);
    assert.equal(res[0].name, "Bash");
    assert.ok(String(res[0].arguments.command).includes('Cookie: $(cat /tmp/c.txt)'));
  });

  it("parses tool_call with invalid JSON escape sequences like \\| in grep", () => {
    const raw = String.raw`{"tool_call":{"name":"Bash","arguments":{"command":"grep -n 'foo\|bar' /tmp/a.html","description":"grep"}}}`;
    const res = parseAllToolCallsFromText(raw);
    assert.equal(res.length, 1);
    assert.equal(res[0].arguments.command, "grep -n 'foo\\|bar' /tmp/a.html");
  });

  it("auto-closes missing trailing brace when model drops final }", () => {
    const raw = `{"tool_call":{"name":"Bash","arguments":{"command":"echo hi","description":"test"}}`;
    const res = parseAllToolCallsFromText(raw);
    assert.equal(res.length, 1);
    assert.equal(res[0].name, "Bash");
    assert.equal(res[0].arguments.command, "echo hi");
  });

  it("parses multiple tool_calls wrapped in <tool_call> tags with leading text and missing brace", () => {
    const raw = `Checking files first.\n<tool_call>\n{"tool_call":{"name":"Bash","arguments":{"command":"grep -n 'a\\|b' /tmp/x","description":"first"}}\n<tool_call>\n{"tool_call":{"name":"Bash","arguments":{"command":"wc -l /tmp/x","description":"second"}}}\n</tool_call>`;
    const res = parseAllToolCallsFromText(raw);
    assert.equal(res.length, 2);
    assert.equal(res[0].arguments.description, "first");
    assert.equal(res[1].arguments.description, "second");
  });

  it("parses Qwen XML <tool_call><function=...><parameter=...> format", () => {
    const raw = `<tool_call>
  <function=Bash>
  <parameter=command>
  cd /home/crypto/crypto_processing && grep -n 'creditAmountlessTransfer\\|holdTransfer' src/services/order.service.ts | head -60
  </parameter>
  <parameter=description>
  Locate amountless credit and AML hold functions
  </parameter>
  </function>
  </tool_call>`;
    const res = parseAllToolCallsFromText(raw);
    assert.equal(res.length, 1);
    assert.equal(res[0].name, "Bash");
    assert.equal(
      res[0].arguments.command,
      "cd /home/crypto/crypto_processing && grep -n 'creditAmountlessTransfer\\|holdTransfer' src/services/order.service.ts | head -60",
    );
    assert.equal(res[0].arguments.description, "Locate amountless credit and AML hold functions");
  });

  it("fixes stray trailing ] bracket (e.g. }}] instead of }}}) with unescaped quotes", () => {
    const raw = String.raw`{"tool_call":{"name":"Bash","arguments":{"command":"grep -rn \"orderNetAmount\|amountlessFinalDueRecord\" src/ ; echo ---; grep -rn \"amountlessFinalDueRecord\" src/ ","description":"Ищу все места"}}]`
    const res = parseAllToolCallsFromText(raw);
    assert.equal(res.length, 1);
    assert.equal(res[0].name, "Bash");
    assert.equal(res[0].arguments.description, "Ищу все места");
  });

  it("fixes stray ] bracket even when followed by } (e.g. }}]})", () => {
    const raw = `{"tool_call":{"name":"Bash","arguments":{"command":"echo ok","description":"test"}}}]}`;
    const res = parseAllToolCallsFromText(raw);
    assert.equal(res.length, 1);
    assert.equal(res[0].name, "Bash");
    assert.equal(res[0].arguments.command, "echo ok");

    const raw2 = String.raw`{"tool_call":{"name":"Bash","arguments":{"command":"grep -n 'a\|b' src/a.ts","description":"test"}}}`;
    const raw2WithBracket = raw2.slice(0, -1) + "]}";
    const res2 = parseAllToolCallsFromText(raw2WithBracket);
    assert.equal(res2.length, 1);
    assert.equal(res2[0].name, "Bash");
  });

  it("preserves full conversation history beyond 20 messages and truncates huge old tool results", () => {
    const msgs = [
      { role: "user", content: "ORIGINAL_TASK_PROMPT" },
      { role: "user", content: `[Tool Result (t1): ${"X".repeat(5000)}]` },
      ...Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? "assistant" : "user",
        content: `step_${i}`,
      })),
    ];
    const prompt = buildConversationPrompt(msgs);
    assert.ok(prompt.includes("ORIGINAL_TASK_PROMPT"));
    assert.ok(prompt.includes("[truncated older tool output]"));
    assert.ok(prompt.includes("step_29"));
  });

  it("sanitizes Claude Code / Anthropic branding in systemPrompt to avoid upstream queue throttling", () => {
    const { systemPrompt } = splitSystemAndPrompt(
      [
        { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude." },
        { role: "user", content: "hi" },
      ],
      [],
    );
    assert.ok(!/claude|anthropic/i.test(systemPrompt));
  });

  it("builds compact tool-injected prompt without pretty-print indentation", () => {
    const prompt = buildPromptWithTools(
      [{ role: "user", content: "list files" }],
      [
        {
          type: "function",
          function: {
            name: "Bash",
            description: "Run   shell\ncommand",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
      ],
    );
    assert.ok(prompt.includes("Function: Bash — Run shell command"));
    assert.ok(prompt.includes('Parameters: {"type":"object","properties":{"command":{"type":"string"}}}'));
    assert.ok(prompt.includes("User: list files"));
  });
});
