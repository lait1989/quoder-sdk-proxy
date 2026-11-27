import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionCache } from "../src/sessionCache.js";

describe("SessionCache", () => {
  it("matches extending conversation and returns only delta messages", () => {
    const cache = new SessionCache();
    const sys = "System prompt";
    const conv1 = [{ role: "user", content: "Hello" }];

    assert.equal(cache.match(sys, "Qwen4-Max", conv1), null);
    cache.save(sys, "Qwen4-Max", conv1, "sess-1");

    const conv2 = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "Next question" },
    ];
    const hit = cache.match(sys, "Qwen4-Max", conv2);
    assert.ok(hit);
    assert.equal(hit.sessionId, "sess-1");
    assert.equal(hit.deltaMessages.length, 2);
    assert.equal(hit.deltaMessages[1].content, "Next question");
  });

  it("invalidates and misses if history was compacted or edited", () => {
    const cache = new SessionCache();
    const sys = "System prompt";
    const conv1 = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];
    cache.save(sys, "Qwen4-Max", conv1, "sess-1");

    const compacted = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Compacted summary" },
      { role: "user", content: "Continue" },
    ];
    assert.equal(cache.match(sys, "Qwen4-Max", compacted), null);
  });
});
