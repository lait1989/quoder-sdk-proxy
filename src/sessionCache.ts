import crypto from "node:crypto";
import { extractText, type SimpleMessage } from "./toolPrompt.js";

export interface CachedSession {
  sessionId: string;
  model: string;
  lastMsgCount: number;
  prefixHash: string;
  updatedAt: number;
}

export function hashMessages(systemPrompt: string, messages: SimpleMessage[]): string {
  const h = crypto.createHash("sha256");
  h.update(systemPrompt);
  for (const m of messages) {
    h.update("\0");
    h.update(m.role);
    h.update(":");
    h.update(extractText(m.content));
  }
  return h.digest("hex");
}

export class SessionCache {
  private readonly entries = new Map<string, CachedSession>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 50, ttlMs = 60 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  makeKey(systemPrompt: string, model: string, conv: SimpleMessage[]): string | null {
    if (conv.length === 0) return null;
    return hashMessages(`${model}\n${systemPrompt}`, [conv[0]]);
  }

  /**
   * Returns `{ sessionId, deltaMessages }` if the incoming conversation
   * strictly extends a cached session, or `null` if a fresh session is needed.
   */
  match(
    systemPrompt: string,
    model: string,
    conv: SimpleMessage[],
  ): { key: string; sessionId: string; deltaMessages: SimpleMessage[] } | null {
    const key = this.makeKey(systemPrompt, model, conv);
    if (!key) return null;

    const entry = this.entries.get(key);
    if (!entry) return null;

    if (Date.now() - entry.updatedAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }

    if (conv.length <= entry.lastMsgCount) {
      return null;
    }

    const currentPrefixHash = hashMessages(systemPrompt, conv.slice(0, entry.lastMsgCount));
    if (currentPrefixHash !== entry.prefixHash) {
      this.entries.delete(key);
      return null;
    }

    return {
      key,
      sessionId: entry.sessionId,
      deltaMessages: conv.slice(entry.lastMsgCount),
    };
  }

  save(systemPrompt: string, model: string, conv: SimpleMessage[], sessionId: string): void {
    const key = this.makeKey(systemPrompt, model, conv);
    if (!key || !sessionId) return;

    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) this.entries.delete(oldestKey);
    }

    this.entries.set(key, {
      sessionId,
      model,
      lastMsgCount: conv.length,
      prefixHash: hashMessages(systemPrompt, conv),
      updatedAt: Date.now(),
    });
  }

  invalidate(systemPrompt: string, model: string, conv: SimpleMessage[]): void {
    const key = this.makeKey(systemPrompt, model, conv);
    if (key) this.entries.delete(key);
  }
}
