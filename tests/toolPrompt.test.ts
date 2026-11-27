import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllToolCallsFromText, buildPromptWithTools } from "../src/toolPrompt.js";

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
