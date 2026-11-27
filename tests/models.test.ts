import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ModelInfo } from "@qoder-ai/qoder-agent-sdk";
import { resolveModelFromList } from "../src/daemon.js";

const MOCK_MODELS: ModelInfo[] = [
  { value: "auto", displayName: "Auto", description: "", modelId: "auto" },
  { value: "ultimate", displayName: "Ultimate", description: "", modelId: "ultimate" },
  { value: "fast", displayName: "Fast", description: "", modelId: "fast" },
  { value: "efficient", displayName: "Efficient", description: "", modelId: "efficient" },
  { value: "qmodel_latest", displayName: "Qwen4-Max", description: "", modelId: "qmodel_latest" },
  { value: "qmodel_38max", displayName: "Qwen3.8-Max", description: "", modelId: "qmodel_38max" },
  { value: "qfmodel", displayName: "Qwen3.8-Flash", description: "", modelId: "qfmodel" },
  { value: "gmodel_latest", displayName: "GLM-5.4", description: "", modelId: "gmodel_latest" },
];

describe("resolveModelFromList", () => {
  it("resolves exact displayName case-insensitively to SDK value", () => {
    assert.equal(resolveModelFromList(MOCK_MODELS, "Qwen4-Max"), "qmodel_latest");
    assert.equal(resolveModelFromList(MOCK_MODELS, "qwen3.8-max"), "qmodel_38max");
    assert.equal(resolveModelFromList(MOCK_MODELS, "GLM-5.4"), "gmodel_latest");
  });

  it("resolves exact value directly", () => {
    assert.equal(resolveModelFromList(MOCK_MODELS, "qmodel_latest"), "qmodel_latest");
  });

  it("resolves Claude/OpenAI/family aliases dynamically", () => {
    assert.equal(resolveModelFromList(MOCK_MODELS, "claude-3-opus"), "ultimate");
    assert.equal(resolveModelFromList(MOCK_MODELS, "claude-3.5-haiku"), "fast");
    assert.equal(resolveModelFromList(MOCK_MODELS, "qwen"), "qmodel_latest");
    assert.equal(resolveModelFromList(MOCK_MODELS, "unknown-model-xyz"), "auto");
  });
});
