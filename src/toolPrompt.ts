import { config } from "./config.js";

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface SimpleMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export function extractText(content: SimpleMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p.text === "string" ? p.text : ""))
    .join("");
}

export function messagesToPrompt(messages: SimpleMessage[]): string {
  if (!messages || messages.length === 0) return "Hello";
  const systemMsg = messages.find((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");

  const parts: string[] = [];
  if (systemMsg) {
    const sys = extractText(systemMsg.content).trim();
    if (sys) parts.push(`System: ${sys}`);
  }
  for (const msg of conversation) {
    const txt = extractText(msg.content).trim();
    if (!txt) continue;
    if (msg.role === "user") parts.push(`User: ${txt}`);
    else if (msg.role === "assistant") parts.push(`Assistant: ${txt}`);
    else if (msg.role === "tool") parts.push(`Tool result: ${txt}`);
  }
  return parts.join("\n\n") || "Hello";
}

export function buildToolSystemPrompt(tools: OpenAITool[]): string {
  if (!tools || tools.length === 0) return "";
  const defs = tools
    .filter((t) => t.type === "function" && t.function)
    .map((t) => {
      const fn = t.function;
      const params = fn.parameters ? JSON.stringify(fn.parameters) : "{}";
      const desc = fn.description ? fn.description.replace(/\s+/g, " ").trim() : "";
      return desc
        ? `Function: ${fn.name} — ${desc}\nParameters: ${params}`
        : `Function: ${fn.name}\nParameters: ${params}`;
    })
    .join("\n");

  return `You have access to the following functions. If you need to invoke a function, respond with ONLY a valid JSON object in this exact format:

{"tool_call":{"name":"<function_name>","arguments":<arguments_object>}}

IMPORTANT: Do NOT attempt native/built-in CLI tool calls — they are disabled. Do NOT wrap output in <tool_call> XML tags. To run any tool (Bash, Read, Edit, Write, Glob, Grep, etc.), output ONLY the raw {"tool_call":...} JSON object in your text response and the host client will execute it and return the result.
If the user is asking a question, discussing code, or no tool call is needed, answer the user directly in plain text.

Available functions:
${defs}`;
}

const MAX_PROMPT_CHARS = parseInt(process.env.QODER_MAX_PROMPT_CHARS || "240000", 10);
const OLD_TOOL_RESULT_MAX_CHARS = 1500;

function formatMsgLine(msg: SimpleMessage, trimToolResults: boolean): string {
  let txt = extractText(msg.content).trim();
  if (!txt) return "";
  if (trimToolResults && txt.length > OLD_TOOL_RESULT_MAX_CHARS && txt.includes("[Tool Result")) {
    txt = txt.slice(0, OLD_TOOL_RESULT_MAX_CHARS) + "\n... [truncated older tool output]";
  }
  if (msg.role === "user") return `User: ${txt}`;
  if (msg.role === "assistant") return `Assistant: ${txt}`;
  if (msg.role === "tool") return `Tool result: ${txt}`;
  return "";
}

export function buildConversationPrompt(messages: SimpleMessage[]): string {
  const conversation = messages.filter((m) => m.role !== "system");
  if (conversation.length === 0) return "Hello";

  const recentCutoff = Math.max(0, conversation.length - 6);
  const formatted = conversation
    .map((m, idx) => formatMsgLine(m, idx < recentCutoff))
    .filter(Boolean);

  if (formatted.length === 0) return "Hello";

  // Always keep the first message (initial task) and as many recent messages as fit within MAX_PROMPT_CHARS
  const totalLen = formatted.reduce((acc, s) => acc + s.length + 2, 0);
  if (totalLen <= MAX_PROMPT_CHARS) {
    return formatted.join("\n\n");
  }

  const first = formatted[0];
  let budget = MAX_PROMPT_CHARS - first.length - 40;
  const keptTail: string[] = [];
  for (let i = formatted.length - 1; i >= 1; i--) {
    const item = formatted[i];
    if (item.length + 2 > budget && keptTail.length > 0) break;
    keptTail.unshift(item);
    budget -= item.length + 2;
  }

  return [first, "... [earlier middle turns omitted for speed] ...", ...keptTail].join("\n\n");
}

export function sanitizeSystemPromptForQoder(text: string): string {
  return text
    .replace(/Anthropic's official CLI for Claude/gi, "a CLI coding assistant")
    .replace(/Claude Code/gi, "the coding assistant")
    .replace(/\bAnthropic\b/gi, "the provider")
    .replace(/\bClaude\b/gi, "Assistant")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CAVEMAN_RULES: Record<"off" | "lite" | "full", string> = {
  off: "",
  lite: "Output style: Be concise. Drop filler words and pleasantries. Keep code, paths, and JSON tool calls 100% standard.",
  full: "Output style: Reply in terse fragments. Drop articles, filler words, pleasantries, and repetition. Keep code, paths, and JSON tool calls 100% standard.",
};

export function splitSystemAndPrompt(
  messages: SimpleMessage[],
  tools: OpenAITool[],
  cavemanMode: "off" | "lite" | "full" = config.cavemanMode,
): { systemPrompt: string; prompt: string } {
  const toolSystem = tools.length > 0 ? buildToolSystemPrompt(tools) : "";
  const systemMsg = messages.find((m) => m.role === "system");
  const rawSystemContent = systemMsg ? extractText(systemMsg.content).trim() : "";
  const systemContent = rawSystemContent ? sanitizeSystemPromptForQoder(rawSystemContent) : "";
  const cavemanRule = CAVEMAN_RULES[cavemanMode] || "";
  const systemPrompt = [systemContent, toolSystem, cavemanRule].filter(Boolean).join("\n\n") ||
    "You are a helpful AI assistant.";
  const prompt = buildConversationPrompt(messages);
  return { systemPrompt, prompt };
}

export function buildPromptWithTools(messages: SimpleMessage[], tools: OpenAITool[]): string {
  if (!tools || tools.length === 0) return messagesToPrompt(messages);

  const toolSystem = buildToolSystemPrompt(tools);
  const systemMsg = messages.find((m) => m.role === "system");
  const systemContent = systemMsg ? extractText(systemMsg.content).trim() : "";
  const conversation = messages.filter((m) => m.role !== "system");

  const parts: string[] = [toolSystem];
  if (systemContent) parts.push(`System context: ${systemContent}`);

  for (const msg of conversation) {
    const txt = extractText(msg.content).trim();
    if (!txt) continue;
    if (msg.role === "user") parts.push(`User: ${txt}`);
    else if (msg.role === "assistant") parts.push(`Assistant: ${txt}`);
    else if (msg.role === "tool") parts.push(`Tool result: ${txt}`);
  }
  return parts.join("\n\n");
}

/**
 * Repairs common LLM JSON formatting issues inside string literals:
 * - unescaped double quotes (e.g. `-H "Cookie: ..."`)
 * - invalid JSON backslash escapes (e.g. `\|` in grep)
 * - raw newlines, carriage returns, tabs
 */
export function sanitizeJsonStrings(raw: string): string {
  let out = "";
  let inStr = false;
  let esc = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) {
        if ('"\\/bfnrtu'.includes(ch)) {
          out += "\\" + ch;
        } else {
          out += "\\\\" + ch;
        }
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        let j = i + 1;
        while (j < raw.length && (raw[j] === " " || raw[j] === "\t" || raw[j] === "\n" || raw[j] === "\r")) {
          j++;
        }
        const nextCh = raw[j];
        if (nextCh === undefined || nextCh === "," || nextCh === "}" || nextCh === "]" || nextCh === ":") {
          out += ch;
          inStr = false;
        } else {
          out += '\\"';
        }
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

function tryParseToolJson(raw: string): ParsedToolCall | null {
  const sanitized = sanitizeJsonStrings(raw);
  const candidates = [
    raw,
    sanitized,
    sanitized.replace(/\}\s*\]+\s*(\}*)\s*$/, "}$1"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        tool_call?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (parsed?.tool_call?.name) {
        return {
          name: parsed.tool_call.name,
          arguments: parsed.tool_call.arguments ?? {},
        };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function parseSingleChunk(chunk: string): ParsedToolCall | null {
  const sanitized = sanitizeJsonStrings(chunk);
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;

  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
  }

  if (end > 0) {
    const res = tryParseToolJson(sanitized.slice(0, end));
    if (res) return res;
  }

  if (depth > 0 && depth <= 3) {
    // Strip trailing non-JSON tags or stray ] brackets (e.g. "}}]") before closing braces
    const trimmed = sanitized
      .replace(/\s*<\/?tool_call>\s*$/i, "")
      .replace(/\]+\s*$/, "");
    const res = tryParseToolJson(trimmed + "}".repeat(depth));
    if (res) return res;
  }

  return null;
}

function parseXmlToolCalls(text: string): ParsedToolCall[] {
  if (!text || !text.includes("<function=")) return [];
  const results: ParsedToolCall[] = [];
  const fnRe = /<function=([^\s>]+)>([\s\S]*?)(?:<\/function>|<\/tool_call>|$)/gi;
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = fnRe.exec(text)) !== null) {
    const name = fnMatch[1].trim();
    const body = fnMatch[2];
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^\s>]+)>([\s\S]*?)<\/parameter>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRe.exec(body)) !== null) {
      const key = pMatch[1].trim();
      const rawVal = pMatch[2].replace(/^\r?\n/, "").replace(/\r?\n\s*$/, "").trim();
      if (
        (rawVal.startsWith("{") && rawVal.endsWith("}")) ||
        (rawVal.startsWith("[") && rawVal.endsWith("]")) ||
        rawVal === "true" ||
        rawVal === "false"
      ) {
        try {
          args[key] = JSON.parse(rawVal);
          continue;
        } catch {
          // keep as string
        }
      }
      args[key] = rawVal;
    }
    if (name) {
      results.push({ name, arguments: args });
    }
  }
  return results;
}

/**
 * Handles: <tool_call>{"name":"X","arguments":{...}}</tool_call>
 * Some models (e.g. Qwen) wrap a bare name/arguments JSON in <tool_call> tags.
 */
function parseXmlWrappedToolCalls(text: string): ParsedToolCall[] {
  if (!text || !text.includes("<tool_call>")) return [];
  const results: ParsedToolCall[] = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1].trim();
    // Try {"name":"...","arguments":{...}}
    try {
      const parsed = JSON.parse(inner) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed?.name) {
        results.push({ name: parsed.name, arguments: parsed.arguments ?? {} });
        continue;
      }
    } catch {
      // fall through
    }
    // Try {"tool_call":{"name":"...","arguments":{...}}}
    const wrapped = tryParseToolJson(inner);
    if (wrapped) results.push(wrapped);
  }
  return results;
}

export function parseAllToolCallsFromText(text: string): ParsedToolCall[] {
  if (!text) return [];

  // Handle <tool_call>{...}</tool_call> XML-wrapped format (Qwen/Mistral style)
  if (text.includes("<tool_call>") && !text.includes('"tool_call"')) {
    const xmlWrapped = parseXmlWrappedToolCalls(text);
    if (xmlWrapped.length > 0) return xmlWrapped;
    // may still contain <function=...> inside
    return parseXmlToolCalls(text);
  }

  if (!text.includes('"tool_call"')) {
    return parseXmlToolCalls(text);
  }

  const results: ParsedToolCall[] = [];
  const starts: number[] = [];
  const re = /\{\s*"tool_call"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    starts.push(m.index);
  }

  for (let idx = 0; idx < starts.length; idx++) {
    const start = starts[idx];
    const nextStart = idx + 1 < starts.length ? starts[idx + 1] : text.length;
    const chunk = text.slice(start, nextStart).replace(/\s*<\/?tool_call>\s*/gi, "\n");
    const parsed = parseSingleChunk(chunk);
    if (parsed) results.push(parsed);
  }

  if (results.length === 0 && starts.length > 0) {
    const start = starts[0];
    const lastBrace = text.lastIndexOf("}");
    if (lastBrace > start) {
      const fallback = tryParseToolJson(text.slice(start, lastBrace + 1));
      if (fallback) results.push(fallback);
    }
  }

  return results;
}
